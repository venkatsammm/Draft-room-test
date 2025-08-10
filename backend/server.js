require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const {setupAbly, getCurrentTurnOrder, getCurrentTurnUserId} = require('./services/ablyHandler');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const axios = require('axios');
const lineupConfigs = require('./config/lineupConfigs.json');
const { isDraftValid } = require('./utils/isDraftValid');
const RedisDraftService = require('./services/redisDraftService');
const PlayerService = require('./services/playerService');



const app = express();
const server = http.createServer(app);
// Allow both 3000 and 3001 for local dev
const allowedOrigins = ["http://localhost:3000", "http://localhost:3001"];
app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));


// Handle preflight requests for all routes
app.options('*', cors());
app.use(express.json());


// Initialize Redis Draft Service and Player Service
const redisDraftService = new RedisDraftService();
const playerService = new PlayerService(redisDraftService);

// Legacy rooms object for backward compatibility
const rooms = {};

// Database integration
const { databaseManager } = require('./services/databaseManager');


// Setup Ably with API key
const ABLY_API_KEY = 'E_U1fw.iYMzEg:KNoWxsCQgLnZ9_oeCL3VWU0NUD3wUB_nbO2rVez2WnA';

// Initialize Ably with better error handling
const Ably = require('ably');
let ably;
let ablyFallbackMode = false;

// Rate limiting for server.js
let serverMessageQueue = [];
let isProcessingServerQueue = false;
let lastServerMessageTime = 0;
const SERVER_MIN_MESSAGE_INTERVAL = 150; // 150ms between messages

try {
  ably = new Ably.Rest({
    key: ABLY_API_KEY,
    endpoint: 'https://rest.ably.io',
    timeout: 10000, // Reduced timeout
    httpMaxRetryCount: 2, // Reduced retries
    fallbackHosts: ['a.ably-realtime.com', 'b.ably-realtime.com'],
    disconnectedRetryTimeout: 5000, // Reduced retry timeout
    suspendedRetryTimeout: 10000 // Reduced suspended retry
  });
  console.log('✅ Ably initialized successfully');
} catch (error) {
  console.error('❌ Failed to initialize Ably:', error.message);
  ably = null;
  ablyFallbackMode = true;
}

// Rate-limited publish function for server.js
async function publishWithServerRateLimit(channel, eventName, data) {
  if (ablyFallbackMode || !ably) {
    console.log(`🔄 Server fallback mode: Skipping Ably publish for ${eventName}`);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const message = { channel, eventName, data, resolve };
    serverMessageQueue.push(message);
    
    if (!isProcessingServerQueue) {
      processServerMessageQueue();
    }
  });
}

// Process server message queue with rate limiting
async function processServerMessageQueue() {
  if (isProcessingServerQueue || serverMessageQueue.length === 0) {
    return;
  }

  isProcessingServerQueue = true;

  while (serverMessageQueue.length > 0) {
    const now = Date.now();
    const timeSinceLastMessage = now - lastServerMessageTime;

    if (timeSinceLastMessage < SERVER_MIN_MESSAGE_INTERVAL) {
      await new Promise(resolve => setTimeout(resolve, SERVER_MIN_MESSAGE_INTERVAL - timeSinceLastMessage));
    }

    const message = serverMessageQueue.shift();
    try {
      await message.channel.publish(message.eventName, message.data);
      lastServerMessageTime = Date.now();
      console.log(`📡 Server rate-limited publish: ${message.eventName}`);
      message.resolve();
    } catch (error) {
      console.error(`❌ Server rate-limited publish failed for ${message.eventName}:`, error.message);
      if (error.code === 42911) {
        // Rate limit exceeded - pause for longer
        console.log('⏸️ Server rate limit hit, pausing for 3 seconds...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        // Put message back at front of queue
        serverMessageQueue.unshift(message);
      } else {
        ablyFallbackMode = true;
        message.resolve();
      }
    }
  }

  isProcessingServerQueue = false;
}

// Chunked publish function for large data
async function publishChunked(channel, eventName, data, chunkSize = 10) {
  if (ablyFallbackMode || !ably) {
    console.log(`🔄 Server fallback mode: Skipping chunked Ably publish for ${eventName}`);
    return Promise.resolve();
  }

  try {
    // If data is small enough, send as single message
    if (!Array.isArray(data) || data.length <= chunkSize) {
      return await publishWithServerRateLimit(channel, eventName, data);
    }

    console.log(`📦 Publishing ${data.length} items in chunks of ${chunkSize} for ${eventName}`);

    // Split large arrays into chunks
    const chunks = [];
    for (let i = 0; i < data.length; i += chunkSize) {
      chunks.push(data.slice(i, i + chunkSize));
    }

    // Send chunks with sequence numbers
    for (let i = 0; i < chunks.length; i++) {
      const chunkData = {
        chunk: chunks[i],
        chunkIndex: i,
        totalChunks: chunks.length,
        isLastChunk: i === chunks.length - 1
      };

      await publishWithServerRateLimit(channel, `${eventName}-chunk`, chunkData);
      
      // Small delay between chunks to avoid overwhelming
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log(`✅ Successfully published ${chunks.length} chunks for ${eventName}`);
    return Promise.resolve();

  } catch (error) {
    console.error(`❌ Error in chunked publish for ${eventName}:`, error.message);
    // Fallback to single message if chunking fails
    return await publishWithServerRateLimit(channel, eventName, data);
  }
}

// Helper function to get selections with usernames
function getSelectionsWithUsernames(room) {
  const selectionsWithUsernames = {};
  
  if (!room.users) return selectionsWithUsernames;
  
  room.users.forEach(user => {
    if (user.selections && Object.keys(user.selections).length > 0) {
      selectionsWithUsernames[user.username || user.id] = user.selections;
    }
  });
  
  return selectionsWithUsernames;
}

// Auto-pick function for users (simple implementation)
function selectPlayerForUser(room, userId) {
  try {
    if (!room || !room.pool || room.pool.length === 0) {
      console.log(`❌ No players available in pool for auto-pick`);
      return null;
    }

    console.log(`🤖 Auto-picking for user ${userId} from ${room.pool.length} available players`);
    
    // Find the user
    const user = room.users.find(u => u.id === userId);
    if (!user) {
      console.log(`❌ User ${userId} not found in room`);
      return null;
    }

    // Smart auto-pick: prioritize active players and balanced positions
    let selectedPlayer = null;
    
    // Try to find an active player first (check both 'Status' and 'status' fields)
    const activePlayer = room.pool.find(p => 
      (p.Status === 'Active' || p.status === 'Active')
    );
    
    if (activePlayer) {
      selectedPlayer = activePlayer;
      console.log(`🎯 Selected active player: ${selectedPlayer.PlayerID} (${selectedPlayer.Position}) - Status: ${selectedPlayer.Status || selectedPlayer.status}`);
    } else {
      // Check what statuses are available in the pool
      const availableStatuses = [...new Set(room.pool.map(p => p.Status || p.status || 'Unknown'))];
      console.log(`⚠️ No 'Active' players found. Available statuses: ${availableStatuses.join(', ')}`);
      
      // Fallback to any available player
      selectedPlayer = room.pool[0];
      console.log(`⚠️ Using fallback player: ${selectedPlayer.PlayerID} (${selectedPlayer.Position}) - Status: ${selectedPlayer.Status || selectedPlayer.status || 'Unknown'}`);
    }
    
    if (!selectedPlayer) {
      console.log(`❌ No players available for auto-pick`);
      return null;
    }

    // Add to user selections
    if (!user.selections) user.selections = {};
    user.selections[selectedPlayer.PlayerID] = {
      playerId: selectedPlayer.PlayerID,
      position: selectedPlayer.Position,
      round: room.draftRound || 1,
      pickTime: new Date().toISOString(),
      autoSelected: true
    };

    // Remove player from pool
    room.pool = room.pool.filter(p => p.PlayerID !== selectedPlayer.PlayerID);

    console.log(`✅ Auto-picked ${selectedPlayer.PlayerID} (${selectedPlayer.Position}) for ${user.username}`);
    
    return {
      PlayerID: selectedPlayer.PlayerID,
      Position: selectedPlayer.Position,
      rosterPosition: selectedPlayer.Position,
      autoSelected: true,
      round: room.draftRound || 1
    };

  } catch (error) {
    console.error(`❌ Error in selectPlayerForUser:`, error.message);
    return null;
  }
}

// Move to next turn in the draft (for auto-picking)
function moveToNextTurn(roomId, rooms) {
  try {
    const room = rooms[roomId];
    if (!room) {
      console.log(`❌ Room ${roomId} not found for turn progression`);
      return;
    }

    console.log(`🔄 Moving to next turn in room ${roomId}`);
    console.log(`   Current turn: ${room.currentTurnIndex}, Round: ${room.draftRound}`);

    // Move to next user
    room.currentTurnIndex++;

    // Check if we've completed a round
    if (room.currentTurnIndex >= room.users.length) {
      room.currentTurnIndex = 0;
      room.draftRound++;
      console.log(`🎉 Round ${room.draftRound - 1} completed! Starting round ${room.draftRound}`);
    }

    // Check if draft is complete
    const maxRounds = room.maxRounds || 15;
    if (room.draftRound > maxRounds) {
      console.log(`🏁 Draft completed in room ${roomId}! Max rounds (${maxRounds}) reached.`);
      room.started = false;
      
      // Publish draft completion
      try {
        if (ably) {
          const channel = ably.channels.get(`draft-room-${roomId}`);
          publishWithServerRateLimit(channel, 'draft-completed', {
            roomId: roomId,
            totalRounds: maxRounds,
            completedAt: new Date().toISOString(),
            finalSelections: getSelectionsWithUsernames(room)
          });
        }
      } catch (publishError) {
        console.error('❌ Error publishing draft completion:', publishError.message);
      }
      
      return;
    }

    // Get next user
    const nextUserId = room.turnOrder[room.currentTurnIndex];
    const nextUser = room.users.find(u => u.id === nextUserId);
    
    if (nextUser) {
      console.log(`👤 Next turn: ${nextUser.username} (${nextUserId}) - Round ${room.draftRound}`);
      
      // Schedule next auto-pick
      setTimeout(() => {
        performAutoPick(roomId, room);
      }, 3000); // 3 second delay between picks
      
    } else {
      console.log(`❌ Next user not found for turn index ${room.currentTurnIndex}`);
    }

    // Publish turn update
    try {
      if (ably) {
        const channel = ably.channels.get(`draft-room-${roomId}`);
        publishWithServerRateLimit(channel, 'turn-changed', {
          currentTurnIndex: room.currentTurnIndex,
          currentUserId: nextUserId,
          currentUsername: nextUser ? nextUser.username : 'Unknown',
          draftRound: room.draftRound,
          remainingPlayers: room.pool.length
        });
      }
    } catch (publishError) {
      console.error('❌ Error publishing turn change:', publishError.message);
    }

  } catch (error) {
    console.error(`❌ Error moving to next turn in room ${roomId}:`, error.message);
  }
}

const ablyHandler = setupAbly(rooms);


// Initialize Redis connection and master data
async function initializeRedis() {
  try {
    const connected = await redisDraftService.connect();
    if (connected) {
      console.log('✅ Redis connected successfully');
      // Initialize master player data in Redis (will fetch from database)
      await redisDraftService.initializeMasterData();
    } else {
      console.log('⚠️ Redis connection failed, using local cache mode');
    }
  } catch (error) {
    console.error('❌ Failed to initialize Redis:', error);
  }
}

// Initialize Redis on startup
initializeRedis();

// Contest monitoring and auto-room creation system
let contestMonitoringInterval = null;
let lastCheckedContests = new Set();

// Auto-pick configuration
const AUTO_PICK_DELAY_MINUTES = 2; // Start auto-picking after 2 minutes
const AUTO_PICK_INTERVAL_SECONDS = 15; // Auto-pick every 15 seconds
let autoPickTimers = new Map(); // Track auto-pick timers for each room

/**
 * Check for new contests and create rooms automatically
 */
async function checkAndCreateRoomsForContests() {
  try {
    console.log('🔍 Checking for new contests from database...');
    
    // Get active contests that need rooms from database
    const contests = await databaseManager.getActiveContestsForRooms();
    console.log(`📊 Found ${contests.length} active contests with users in database`);
    
    if (contests.length === 0) {
      console.log('ℹ️ No active contests with users found for today');
      return;
    }
    
    // Process each contest
    for (const contest of contests) {
      const contestId = contest.contest_id || contest.id; // Handle both column names
      
      // Skip if we've already processed this contest
      if (lastCheckedContests.has(contestId)) {
        console.log(`⏭️ Contest ${contestId} already processed, skipping...`);
        continue;
      }
      
      console.log(`🏈 Processing contest: ${contestId} - Status: ${contest.contest_status}`);
      console.log(`📅 Contest status: ${contest.contest_status}, Start time: ${contest.start_time}`);
      
      // Verify users exist for this contest before creating room
      try {
        const contestUsers = await databaseManager.getContestUsers(contestId);
        console.log(`👥 Contest ${contestId} has ${contestUsers.length} users in database`);
        
        if (contestUsers.length < 2) {
          console.log(`⚠️ Contest ${contestId} has insufficient users (${contestUsers.length}), skipping room creation`);
          continue;
        }
        
        // Create room for this contest
        const roomId = await createRoomForContest(contest);
        
        if (roomId) {
          console.log(`✅ Created room ${roomId} for contest ${contestId} with ${contestUsers.length} users`);
          lastCheckedContests.add(contestId);
        } else {
          console.log(`❌ Failed to create room for contest ${contestId}`);
        }
      } catch (userError) {
        console.error(`❌ Error processing contest ${contestId}:`, userError.message);
        continue;
      }
    }
    
    console.log(`📋 Contest monitoring complete. Total contests processed: ${lastCheckedContests.size}`);
    
  } catch (error) {
    console.error('❌ Error in contest monitoring:', error.message);
  }
}

/**
 * Create a room for a specific contest
 */
async function createRoomForContest(contest) {
  try {
    const roomId = generateRoomId();
    const contestId = contest.id || contest.contest_id; // Handle both column names
    const contestName = `Contest ${contestId}`; // Use contest ID as name since contest_name doesn't exist
    
    console.log(`🏗️ Creating room ${roomId} for contest: ${contestName} (ID: ${contestId})`);
    
    // Get users for this contest from database
    let contestUsers = [];
    try {
      contestUsers = await databaseManager.getContestUsers(contestId);
      console.log(`👥 Found ${contestUsers.length} users for contest ${contestId} from database`);
      
      if (contestUsers.length === 0) {
        console.log(`⚠️ No users found in database for contest ${contestId}. Skipping room creation.`);
        return null;
      }
    } catch (userError) {
      console.error('❌ Error fetching contest users from database:', userError.message);
      console.log(`⚠️ Cannot create room without users. Skipping room creation for contest ${contestId}.`);
      return null;
    }
    
    // Create room configuration based on contest
    const roomConfig = {
      maxRounds: 15,
      maxMainPlayers: 5,
      maxBenchPlayers: 2,
      selectionPhase: 'main',
      contestId: contestId,
      contestName: contestName,
      contestData: {
        startTime: contest.start_time,
        status: contest.contest_status,
        gameIds: contest.game_ids || []
      }
    };
    
    // Create room in Redis
    await redisDraftService.createRoom(roomId, roomConfig);
    
    // Also create in legacy rooms object for backward compatibility
    const playerPool = await generatePlayerPool();
    
    // Convert contest users to room users format from database
    const roomUsers = contestUsers.map((user, index) => ({
      id: user.user_id || user.id || `db_user_${index + 1}`,
      username: user.username || `User${index + 1}`,
      clientId: null, // Will be set when user connects
      isHost: index === 0, // First user becomes host
      joinedAt: new Date().toISOString(),
      selections: {},
      isConnected: false,
      email: user.email || null,
      contestId: contestId,
      source: 'database'
    }));
    
    console.log(`✅ Successfully converted ${roomUsers.length} database users to room format`);
    console.log(`📋 Users assigned to room: ${roomUsers.map(u => u.username).join(', ')}`);
    
    // Store users in Redis immediately
    await redisDraftService.updateRoomUsers(roomId, roomUsers);
    console.log(`✅ Stored ${roomUsers.length} users in Redis for room ${roomId}`);
    
    rooms[roomId] = {
      hostId: roomUsers.length > 0 ? roomUsers[0].id : null,
      users: roomUsers,
      selections: {},
      turnOrder: roomUsers.map(user => user.id), // Set turn order based on database users
      currentTurnIndex: 0,
      started: false,
      pool: playerPool,  // ← PLAYER DATA STORED HERE (PlayerID, Position)
      preferredQueue: {},
      timer: null,
      createdAt: new Date().toISOString(),
      disconnectedUsers: [],
      selectionPhase: 'main',
      maxMainPlayers: 5,
      maxBenchPlayers: 2,
      draftRound: 1,
      maxRounds: 15,
      contestId: contestId,
      contestName: contestName,
      contestData: roomConfig.contestData,
      source: 'database_contest'
    };

    // Publish room creation to Ably
    try {
      if (ably) {
        const channel = ably.channels.get(`draft-room-${roomId}`);
        
        // Get room stats from Redis
        const roomStats = await redisDraftService.getRoomStats(roomId);
        
        await publishWithServerRateLimit(channel, 'room-created', {
          roomId: roomId,
          createdAt: new Date().toISOString(),
          source: 'database_contest_creation',
          contestId: contestId,
          contestName: contestName,
          stats: {
            totalPlayers: roomStats.totalPlayers || 0,
            availablePlayers: roomStats.availablePlayers || 0,
            maxRounds: roomConfig.maxRounds,
            status: 'created',
            usersAssigned: roomUsers.length,
            usersFromDatabase: true
          }
        });
        console.log(`✅ Published database contest room creation to Ably`);
      }
    } catch (ablyError) {
      console.error('❌ Error publishing contest room creation to Ably:', ablyError.message);
    }
    
    console.log(`🎉 SUCCESS: Room ${roomId} created for contest ${contestId} from database`);
    console.log(`📋 Room Details:`);
    console.log(`   - Room ID: ${roomId}`);
    console.log(`   - Contest: ${contestName}`);
    console.log(`   - Contest ID: ${contestId}`);
    console.log(`   - Status: ${contest.contest_status}`);
    console.log(`   - Start Time: ${contest.start_time}`);
    console.log(`   - Players Available: ${playerPool.length}`);
    console.log(`   - Users Assigned from DB: ${roomUsers.length}`);
    console.log(`   - Users: ${roomUsers.map(u => u.username).join(', ')}`);
    console.log(`   - Created At: ${new Date().toISOString()}`);
    console.log(`   - Source: Database Contest`);
    console.log(`   ──────────────────────────────────────────`);
    
    // Start auto-pick timer for this room
    startAutoPickTimer(roomId, rooms[roomId]);
    
    return roomId;
    
  } catch (error) {
    console.error(`❌ Failed to create room for contest ${contest.id || contest.contest_id}:`, error.message);
    return null;
  }
}

/**
 * Start contest monitoring
 */
function startContestMonitoring() {
  console.log('🚀 Starting contest monitoring system...');
  
  // Check immediately on startup
  checkAndCreateRoomsForContests();
  
  // Set up periodic checking (every 5 minutes)
  contestMonitoringInterval = setInterval(checkAndCreateRoomsForContests, 5 * 60 * 1000);
  
  console.log('✅ Contest monitoring started - checking every 5 minutes');
}

/**
 * Stop contest monitoring
 */
function stopContestMonitoring() {
  if (contestMonitoringInterval) {
    clearInterval(contestMonitoringInterval);
    contestMonitoringInterval = null;
    console.log('🛑 Contest monitoring stopped');
  }
}

/**
 * Start auto-pick timer for a room
 */
function startAutoPickTimer(roomId, room) {
  console.log(`⏰ Starting auto-pick timer for room ${roomId}`);
  console.log(`⏰ Auto-pick will start in ${AUTO_PICK_DELAY_MINUTES} minutes`);
  
  // Clear any existing timer
  if (autoPickTimers.has(roomId)) {
    clearTimeout(autoPickTimers.get(roomId));
  }
  
  // Set timer to start auto-picking after delay
  const autoPickDelay = AUTO_PICK_DELAY_MINUTES * 60 * 1000; // Convert to milliseconds
  const timer = setTimeout(() => {
    console.log(`🚀 Auto-pick timer expired for room ${roomId} - starting auto-picking`);
    startAutoPicking(roomId, room);
  }, autoPickDelay);
  
  autoPickTimers.set(roomId, timer);
  
  // Log the auto-pick schedule
  const startTime = new Date();
  const autoPickStartTime = new Date(startTime.getTime() + autoPickDelay);
  console.log(`📅 Room ${roomId} auto-pick schedule:`);
  console.log(`   Start time: ${startTime.toLocaleTimeString()}`);
  console.log(`   Auto-pick starts: ${autoPickStartTime.toLocaleTimeString()}`);
  console.log(`   Delay: ${AUTO_PICK_DELAY_MINUTES} minutes`);
  console.log(`   Interval: ${AUTO_PICK_INTERVAL_SECONDS} seconds`);
}

/**
 * Start auto-picking for a room
 */
function startAutoPicking(roomId, room) {
  try {
    console.log(`🤖 Starting auto-picking for room ${roomId}`);
    
    // Check if room exists and has users
    if (!room || !room.users || room.users.length === 0) {
      console.log(`❌ Cannot start auto-picking for room ${roomId} - no users found`);
      return;
    }
    
    // Check if draft has already started
    if (room.started) {
      console.log(`⚠️ Draft already started for room ${roomId} - auto-picking not needed`);
      return;
    }
    
    console.log(`🎯 Auto-picking for room ${roomId} with ${room.users.length} users`);
    console.log(`📋 Users: ${room.users.map(u => u.username).join(', ')}`);
    
    // Start the draft automatically
    room.started = true;
    room.turnOrder = room.users.map(u => u.id);
    room.currentTurnIndex = 0;
    room.draftRound = 1;
    room.selectionPhase = 'main';
    
    console.log(`🚀 Auto-started draft for room ${roomId}`);
    console.log(`🔄 Turn order: ${room.turnOrder.map(id => {
      const user = room.users.find(u => u.id === id);
      return user ? user.username : id;
    }).join(' → ')}`);
    
    // Publish draft started event
    if (ably) {
      const channel = ably.channels.get(`draft-room-${roomId}`);
      publishChunked(channel, 'draft-started-pool', room.pool, 10);
      
      const currentTurnOrder = getCurrentTurnOrder(room);
      publishWithServerRateLimit(channel, 'draft-started-meta', {
        turnOrder: currentTurnOrder.map(id => {
          const user = room.users.find(u => u.id === id);
          return user ? user.username : null;
        }).filter(Boolean),
        currentUser: room.users.find(u => u.id === currentTurnOrder[0])?.username,
        selectionPhase: room.selectionPhase,
        draftRound: room.draftRound,
        autoStarted: true
      });
    }
    
    // Start the first turn
    setTimeout(() => {
      startTurn(roomId, rooms);
    }, 1000);
    
  } catch (error) {
    console.error(`❌ Error starting auto-picking for room ${roomId}:`, error.message);
  }
}

/**
 * Perform auto-pick for a room
 */
function performAutoPick(roomId, room) {
  try {
    console.log(`🤖 Performing auto-pick for room ${roomId}`);
    
    // Check if room exists and draft is started
    if (!room || !room.started) {
      console.log(`❌ Cannot perform auto-pick for room ${roomId} - draft not started`);
      return;
    }
    
    // Check if draft is completed
    if (room.draftRound > room.maxRounds) {
      console.log(`🏁 Draft completed for room ${roomId} - stopping auto-pick`);
      stopAutoPicking(roomId);
      return;
    }
    
    // Get current turn user
    const currentTurnUserId = getCurrentTurnUserId(room);
    if (!currentTurnUserId) {
      console.log(`❌ No current turn user found for room ${roomId}`);
      return;
    }
    
    const currentUser = room.users.find(u => u.id === currentTurnUserId);
    if (!currentUser) {
      console.log(`❌ Current turn user not found for room ${roomId}`);
      return;
    }
    
    // Check if this user already has picks for this round to prevent double-picking
    const userPicksThisRound = (room.selections[currentTurnUserId] || []).filter(
      pick => pick.round === room.draftRound
    ).length;
    
    if (userPicksThisRound > 0) {
      console.log(`⚠️ User ${currentUser.username} already has ${userPicksThisRound} pick(s) for round ${room.draftRound}, skipping auto-pick`);
      moveToNextTurn(roomId, rooms);
      return;
    }
    
    console.log(`🎯 Auto-picking for ${currentUser.username} in room ${roomId} (Round ${room.draftRound})`);
    
    // Perform auto-pick for current user
    const selection = selectPlayerForUser(room, currentTurnUserId);
    if (selection) {
      console.log(`✅ Auto-picked ${selection.PlayerID} (${selection.Position}) for ${currentUser.username}`);
      
      // Add player to user's selections with round info
      if (!room.selections[currentTurnUserId]) {
        room.selections[currentTurnUserId] = [];
      }
      
      // Add round information to the selection
      const selectionWithRound = {
        ...selection,
        round: room.draftRound,
        pickTime: new Date().toISOString(),
        autoSelected: true
      };
      
      room.selections[currentTurnUserId].push(selectionWithRound);
      
      // Remove player from pool
      const playerIndex = room.pool.findIndex(p => p.PlayerID === selection.PlayerID);
      if (playerIndex !== -1) {
        room.pool.splice(playerIndex, 1);
      }
      
      // Publish auto-pick event
      if (ably) {
        const channel = ably.channels.get(`draft-room-${roomId}`);
        publishChunked(channel, 'player-selected-pool', room.pool, 10);
        publishChunked(channel, 'player-selected-selections', Object.entries(getSelectionsWithUsernames(room)), 10);
        publishWithServerRateLimit(channel, 'player-selected-meta', {
          player: selection,
          selectedBy: currentUser.username,
          userId: currentTurnUserId,
          autoSelected: true,
          wasPreferred: false
        });
      }
      
      // Move to next turn
      moveToNextTurn(roomId, rooms);
      
    } else {
      console.log(`❌ No valid player available for auto-pick in room ${roomId}`);
      // Move to next turn even if no player available
      moveToNextTurn(roomId, rooms);
    }
    
  } catch (error) {
    console.error(`❌ Error performing auto-pick for room ${roomId}:`, error.message);
  }
}

/**
 * Stop auto-picking for a room
 */
function stopAutoPicking(roomId) {
  try {
    if (autoPickTimers.has(roomId)) {
      clearInterval(autoPickTimers.get(roomId));
      autoPickTimers.delete(roomId);
      console.log(`🛑 Auto-pick stopped for room ${roomId}`);
    }
  } catch (error) {
    console.error(`❌ Error stopping auto-pick for room ${roomId}:`, error.message);
  }
}

/**
 * Make a pick in the draft
 */
function makePick(roomId, userId, playerId) {
  try {
    const room = rooms[roomId];
    if (!room) {
      console.error(`❌ Room ${roomId} not found for pick`);
      return;
    }
    
    const user = room.users.find(u => u.id === userId);
    if (!user) {
      console.error(`❌ User ${userId} not found in room ${roomId}`);
      return;
    }
    
    const player = room.pool.find(p => p.PlayerID === playerId);
    if (!player) {
      console.error(`❌ Player ${playerId} not found in room ${roomId}`);
      return;
    }
    
    // Add pick to user's selections
    if (!user.selections) user.selections = {};
    user.selections[playerId] = {
      playerId: playerId,
      playerName: `Player ${playerId}`, // Simplified data doesn't have Name
      position: player.Position,
      round: room.draftRound,
      pickTime: new Date().toISOString()
    };
    
    // Remove player from pool
    room.pool = room.pool.filter(p => p.PlayerID !== playerId);
    
    console.log(`✅ Pick made: ${user.username} selected Player ${playerId} (${player.Position}) in round ${room.draftRound}`);
    
    // Publish pick to Ably
    try {
      if (ably) {
        const channel = ably.channels.get(`draft-room-${roomId}`);
        publishWithServerRateLimit(channel, 'pick-made', {
          userId: userId,
          username: user.username,
          playerId: playerId,
          playerName: `Player ${playerId}`,
          position: player.Position,
          round: room.draftRound,
          timestamp: new Date().toISOString()
        });
      }
    } catch (ablyError) {
      console.error('❌ Error publishing pick to Ably:', ablyError.message);
    }
    
  } catch (error) {
    console.error(`❌ Error making pick in room ${roomId}:`, error.message);
  }
}

// Start contest monitoring after Redis initialization
setTimeout(() => {
  startContestMonitoring();
}, 3000); // Wait 3 seconds after server startup

// Create Room
app.post('/api/create-room', async (req, res) => {
  try {
    const roomId = generateRoomId();
    
    // Create room in Redis
    const roomConfig = {
      maxRounds: 15,
      maxMainPlayers: 5,
      maxBenchPlayers: 2,
      selectionPhase: 'main'
    };
    
    await redisDraftService.createRoom(roomId, roomConfig);
    
    // Also create in legacy rooms object for backward compatibility
    const playerPool = await generatePlayerPool();
    rooms[roomId] = {
      hostId: null,
      users: [],
      selections: {},
      turnOrder: [],
      currentTurnIndex: 0,
      started: false,
      pool: playerPool,
      preferredQueue: {},
      timer: null,
      createdAt: new Date().toISOString(),
      disconnectedUsers: [],
      selectionPhase: 'main',
      maxMainPlayers: 5,
      maxBenchPlayers: 2,
      draftRound: 1,
      maxRounds: 15
    };

    // Publish room creation to Ably with OPTIMIZED minimal data
    try {
      if (ably) {
        const channel = ably.channels.get(`draft-room-${roomId}`);
        
        // Get room stats from Redis
        const roomStats = await redisDraftService.getRoomStats(roomId);
        
        // OPTIMIZATION: Send only essential room data (RATE LIMITED)
        await publishWithServerRateLimit(channel, 'room-created', {
          roomId: roomId,
          createdAt: new Date().toISOString(),
          source: 'redis-api-optimized',
          stats: {
            totalPlayers: roomStats.totalPlayers || 0,
            availablePlayers: roomStats.availablePlayers || 0,
            maxRounds: roomConfig.maxRounds,
            status: 'created'
          }
        });
        console.log(`✅ Published OPTIMIZED room creation to Ably (minimal data, RATE LIMITED)`);
      } else {
        console.log(`🔄 Ably not available - skipping room creation notification for room ${roomId}`);
      }
    } catch (ablyError) {
      console.error('❌ Error publishing room creation to Ably:', ablyError.message);
      console.log(`🔄 Continuing without real-time notification for room ${roomId}`);
    }
    
    console.log(`✅ Room ${roomId} created with Redis integration`);
    res.json({ roomId, message: 'NFL Draft Room created successfully with Redis' });
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});


// Get Room Info
app.get('/api/room/:roomId', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  // Get current turn order with usernames (for snake draft)
  const currentTurnOrder = getCurrentTurnOrder(room);
  const turnOrderWithUsernames = currentTurnOrder.map(clientId => {
    const user = room.users.find(u => u.clientId === clientId);
    return user ? user.username : 'Unknown User';
  });

  res.json({
    roomId: req.params.roomId,
    userCount: room.users.length,
    users: room.users.map(u => ({ username: u.username })),
    started: room.started,
    poolSize: room.pool.length,
    createdAt: room.createdAt,
    currentRound: room.draftRound,
    selectionPhase: room.selectionPhase,
    turnOrder: room.turnOrder,
    turnOrderWithUsernames: turnOrderWithUsernames,
    currentTurnIndex: room.currentTurnIndex,
    maxRounds: room.maxRounds,
    isSnakeDraft: true
  });
});


// Get All Rooms
app.get('/api/rooms', (req, res) => {
  const roomList = Object.keys(rooms).map(roomId => ({
    roomId,
    userCount: rooms[roomId].users.length,
    started: rooms[roomId].started,
    createdAt: rooms[roomId].createdAt,
    currentRound: rooms[roomId].draftRound
  }));
  res.json({ rooms: roomList, total: roomList.length });
});


// Ably token endpoint for client authentication
app.post('/api/ably-token', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) {
    return res.status(400).json({ error: 'Client ID is required' });
  }


  const Ably = require('ably');
  const ably = new Ably.Rest({
    key: ABLY_API_KEY
  });


  try {
    const tokenRequest = await ably.auth.createTokenRequest({ clientId });
    res.json(tokenRequest);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create Ably token', details: err.message });
  }
});


// Join room endpoint
app.post('/api/join-room', (req, res) => {
  const { roomId, username, clientId } = req.body;
 
  if (!roomId || !username || !clientId) {
    return res.status(400).json({ error: 'Room ID, username, and client ID are required' });
  }


  const result = ablyHandler.handleJoinRoom(roomId, username, clientId);
 
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
 
  if (result.status === 'generating_pool') {
    return res.json({ status: 'generating_pool', message: 'Generating player pool...' });
  }
 
  res.json(result);
});


// Set preferred players endpoint
app.post('/api/set-preferred-players', (req, res) => {
  const { roomId, clientId, preferredPlayers } = req.body;
 
  if (!roomId || !clientId || !preferredPlayers) {
    return res.status(400).json({ error: 'Room ID, client ID, and preferred players are required' });
  }


  const result = ablyHandler.handleSetPreferredPlayers(roomId, clientId, preferredPlayers);
 
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
 
  res.json(result);
});


// Start draft endpoint
app.post('/api/start-draft', (req, res) => {
  const { roomId, clientId } = req.body;
 
  if (!roomId || !clientId) {
    return res.status(400).json({ error: 'Room ID and client ID are required' });
  }


  const result = ablyHandler.handleStartDraft(roomId, clientId);
 
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
 
  res.json(result);
});


// Select player endpoint
app.post('/api/select-player', (req, res) => {
  const { roomId, clientId, playerID } = req.body;
 
  if (!roomId || !clientId || !playerID) {
    return res.status(400).json({ error: 'Room ID, client ID, and player ID are required' });
  }


  const result = ablyHandler.handleSelectPlayer(roomId, clientId, playerID);
 
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
 
  res.json(result);
});


// Disconnect endpoint
app.post('/api/disconnect', (req, res) => {
  const { roomId, clientId } = req.body;
 
  if (!roomId || !clientId) {
    return res.status(400).json({ error: 'Room ID and client ID are required' });
  }


  const result = ablyHandler.handleDisconnect(roomId, clientId);
 
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
 
  res.json(result);
});


app.get('/api/lineup-configs', (req, res) => {
  res.json(lineupConfigs);
});



app.get('/', (req, res) => {
  res.json({
    message: '🏈 Real-time NFL Team Selection Backend Running with Ably',
    activeRooms: Object.keys(rooms).length,
    timestamp: new Date().toISOString()
  });
});


// Utility: Room ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}


// Generate player pool from database with fallback
// Returns only PlayerID and Position, sorted by status (future: ADP)
async function generatePlayerPool() {
  try {
    console.log('🏈 Generating player pool from database (PlayerID and Position only)...');
    
    // Fetch players from database (only PlayerID and Position) - Using today's contest players
    let players = [];
    try {
      players = await databaseManager.getTodayPlayers();
      console.log(`✅ Fetched ${players.length} players (PlayerID, Position) for today's contests from database`);
      
      // If no players for today, fallback to all fantasy players
      if (players.length === 0) {
        console.log('⚠️ No players found for today\'s contests. Using all fantasy players...');
        players = await databaseManager.getAllFantasyPlayers();
        console.log(`✅ Fallback: Fetched ${players.length} players (PlayerID, Position) from all fantasy players`);
      }
    } catch (dbError) {
      console.error('❌ Database fetch failed:', dbError.message);
      throw new Error('Unable to fetch players from database');
    }

    // Define the positions to be included in the draft
    const allowedPositions = ['QB', 'RB', 'WR', 'TE', 'DST', 'K'];

    // Filter players by the allowed positions (if not already filtered)
    const filteredPlayers = players.filter(player => 
      player.Position && allowedPositions.includes(player.Position)
    );
    console.log(`✅ Filtered players to ${filteredPlayers.length} based on allowed positions`);

    // Group players by position
    const positionGroups = {};
    allowedPositions.forEach(pos => {
      positionGroups[pos] = [];
    });
    for (const player of filteredPlayers) {
      if (positionGroups[player.Position]) {
        positionGroups[player.Position].push(player);
      }
    }

    // Log how many players per position
    allowedPositions.forEach(pos => {
      console.log(`[DEBUG] ${pos}: ${positionGroups[pos].length} players`);
    });

    // Check if we have enough players
    if (filteredPlayers.length === 0) {
      console.log('⚠️ No players found with position filtering.');
      
      // Try returning all players from database without position filtering
      if (players.length > 0) {
        console.log('🔄 Using all database players without position filtering...');
        const allPlayers = players.map(player => ({
          PlayerID: player.PlayerID,
          Position: player.Position || 'UNKNOWN'
        }));
        console.log(`✅ Using ${allPlayers.length} unfiltered database players`);
        return allPlayers;
      } else {
        // Throw error if no database players at all
        throw new Error('No players found in database');
      }
    }

    // Use filtered players (PlayerID and Position only)
    const pool = filteredPlayers;

    // Final pool size check
    console.log(`✅ Created balanced pool with ${pool.length} players (PlayerID and Position) sorted by status priority`);
    return pool;
  } catch (error) {
    console.error("❌ Error generating player pool:", error.message);
    
    // Since you want ONLY database data, throw error instead of using fallback
    console.error('🚫 ONLY DATABASE DATA ALLOWED - No fallback pool will be created');
    throw new Error(`Failed to generate player pool from database: ${error.message}`);
  }
}


// Auto-pick player endpoint
app.post('/api/auto-pick-player', (req, res) => {
  try {
    const { roomId, clientId } = req.body;
    
    if (!roomId || !clientId) {
      return res.status(400).json({ error: 'Missing roomId or clientId' });
    }

    const room = rooms[roomId];
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    if (!room.started) {
      return res.status(400).json({ error: 'Draft has not started yet' });
    }

    // Find the user by clientId
    const user = room.users.find(u => u.clientId === clientId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if it's the user's turn
    const currentTurnUserId = getCurrentTurnUserId(room);
    if (currentTurnUserId !== user.id) {
      return res.status(400).json({ error: 'Not your turn' });
    }

    console.log(`🤖 Auto-pick requested by ${user.username} in room ${roomId}`);
    console.log(`🔍 User ID: ${user.id}, Client ID: ${user.clientId}`);
    
    // Using selectPlayerForUser function defined above
    const selectedPlayer = selectPlayerForUser(room, user.id);
   
    if (selectedPlayer) {
      console.log(`✅ Auto-pick successful: ${user.username} selected ${selectedPlayer.PlayerID} (${selectedPlayer.Position}) -> ${selectedPlayer.rosterPosition}`);
      console.log(`🎯 Source: ${selectedPlayer.autoPickSource}${selectedPlayer.wasPreferred ? ` (preferred #${selectedPlayer.preferenceOrder})` : ''}`);
      
      // SNAKE DRAFT: Move to next turn using the corrected logic
      room.currentTurnIndex++;
      
      // Check if round is complete
      if (room.currentTurnIndex >= room.turnOrder.length) {
        // Round complete - start next round
        room.draftRound++;
        
        // Check if draft is complete
        if (room.draftRound > room.maxRounds) {
          console.log(`🏁 Draft completed for room ${roomId}`);
          res.json({ 
            success: true, 
            message: 'Draft completed',
            selection: {
              player: selectedPlayer,
              wasPreferred: selectedPlayer.wasPreferred || false,
              source: selectedPlayer.autoPickSource || 'auto-pick',
              preferenceOrder: selectedPlayer.preferenceOrder
            }
          });
          return;
        }
        
        // SNAKE DRAFT: Keep original turnOrder, calculate order dynamically
        console.log(`🔄 SNAKE DRAFT: Round ${room.draftRound} - Turn order calculated dynamically`);
        
        // Reset to first player in the new order
        room.currentTurnIndex = 0;
      }
      
      res.json({ 
        success: true, 
        message: 'Auto-pick successful',
        selection: {
          player: selectedPlayer,
          wasPreferred: selectedPlayer.wasPreferred || false,
          source: selectedPlayer.autoPickSource || 'auto-pick',
          preferenceOrder: selectedPlayer.preferenceOrder
        }
      });
    } else {
      console.log(`❌ Auto-pick failed for ${user.username}: no valid players available`);
      
      // SNAKE DRAFT: Move to next turn even if auto-pick failed
      room.currentTurnIndex++;
      
      // Check if round is complete
      if (room.currentTurnIndex >= room.turnOrder.length) {
        // Round complete - start next round
        room.draftRound++;
        
        // Check if draft is complete
        if (room.draftRound > room.maxRounds) {
          console.log(`🏁 Draft completed for room ${roomId}`);
          res.json({ 
            success: false, 
            message: 'Draft completed - no valid players available',
            selection: null
          });
          return;
        }
        
        // SNAKE DRAFT: Keep original turnOrder, calculate order dynamically
        console.log(`🔄 SNAKE DRAFT: Round ${room.draftRound} - Turn order calculated dynamically`);
        
        // Reset to first player in the new order
        room.currentTurnIndex = 0;
      }
      
      res.json({ 
        success: false, 
        message: 'Auto-pick failed - no valid players available',
        selection: null
      });
    }
    
    return;

  } catch (error) {
    console.error('Error in auto-pick endpoint:', error);
    res.status(500).json({ error: 'Internal server error during auto-pick' });
  }
});

const PORT = process.env.PORT || 8000;


server.listen(PORT, () => {
  console.log(`🏈 NFL Team Selection Server running on port ${PORT} with Ably & Redis`);
  console.log(`📊 Server started at ${new Date().toISOString()}`);
  console.log(`🌐 Server accessible at http://localhost:${PORT}`);
  console.log(`🔗 Redis-based draft system enabled with Negative Sets Pattern`);
  console.log(`📈 New API endpoints available:`);
  console.log(`   - GET /api/room/:roomId/available-players`);
  console.log(`   - GET /api/room/:roomId/picked-players`);
  console.log(`   - POST /api/room/:roomId/pick-player`);
  console.log(`   - GET /api/room/:roomId/stats`);
  console.log(`   - GET /api/room/:roomId/summary`);
  console.log(`   - GET /api/redis/health`);
});


// Error handling for server
server.on('error', (error) => {
  console.error('Server error:', error);
});


process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});


process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});


app.get('/api/players', async (req, res) => {
  try {
    const players = await databaseManager.getAllFantasyPlayers();
    res.json(players);
  } catch (error) {
    console.error('Error fetching players:', error);
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});


// Test Ably connection endpoint with improved error handling
app.get('/api/ably-test', async (req, res) => {
  try {
    console.log('🧪 Testing Ably connection with improved configuration...');

    // Use the global ably instance
    const testChannel = ably.channels.get('test-connection');
    console.log('✅ Channel created successfully');
    
    await testChannel.publish('test', { 
      message: 'Connection test successful with improved config', 
      timestamp: new Date().toISOString(),
      source: 'redis-api',
      config: {
        timeout: 15000,
        httpMaxRetryCount: 5,
        fallbackHosts: 'configured'
      }
    });
    console.log('✅ Message published successfully');
   
    res.json({
      status: 'success',
      message: 'Ably connection test successful with improved configuration',
      timestamp: new Date().toISOString(),
      apiKey: ABLY_API_KEY.substring(0, 10) + '...', // Only show first 10 chars for security
      config: {
        timeout: 15000,
        httpMaxRetryCount: 5,
        fallbackHosts: 'configured'
      }
    });
  } catch (error) {
    console.error('❌ Ably connection test failed:', error);
    res.status(500).json({
      status: 'error',
      message: 'Ably connection test failed',
      error: error.message,
      details: {
        name: error.name,
        code: error.code,
        statusCode: error.statusCode
      },
      timestamp: new Date().toISOString()
    });
  }
});


// Get Ably connection status with detailed configuration
app.get('/api/ably-status', (req, res) => {
  try {
    res.json({
      status: 'ready',
      message: 'Ably REST client initialized with improved configuration',
      apiKeyConfigured: !!ABLY_API_KEY,
      apiKeyLength: ABLY_API_KEY ? ABLY_API_KEY.length : 0,
      config: {
        endpoint: 'https://rest.ably.io',
        timeout: 15000,
        httpMaxRetryCount: 5,
        fallbackHosts: ['a.ably-realtime.com', 'b.ably-realtime.com', 'c.ably-realtime.com', 'd.ably-realtime.com', 'e.ably-realtime.com'],
        disconnectedRetryTimeout: 15000,
        suspendedRetryTimeout: 30000
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to initialize Ably',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Test Database connection
app.get('/api/test/database', async (req, res) => {
  try {
    console.log('🧪 Testing database connection...');
    const players = await databaseManager.getAllFantasyPlayers();
    res.json({ 
      status: 'success', 
      message: 'Database connection test successful',
      playerCount: players.length,
      samplePlayers: players.slice(0, 3).map(p => ({ id: p.PlayerID, name: p.Name, position: p.Position })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Database test failed:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'Database connection test failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Test Redis connection
app.get('/api/test/redis', async (req, res) => {
  try {
    console.log('🧪 Testing Redis connection...');
    const health = await redisDraftService.healthCheck();
    res.json({ 
      status: 'success', 
      message: 'Redis connection test successful',
      health: health,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Redis test failed:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'Redis connection test failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Test player data fetching
app.get('/api/test/players', async (req, res) => {
  try {
    console.log('🧪 Testing player data fetching...');
    const players = await databaseManager.getAllFantasyPlayers();
    
    // Analyze the data
    const positionCounts = {};
    players.forEach(player => {
      positionCounts[player.Position] = (positionCounts[player.Position] || 0) + 1;
    });
    
    res.json({ 
      status: 'success', 
      message: 'Player data fetching test successful',
      totalPlayers: players.length,
      positionDistribution: positionCounts,
      samplePlayers: players.slice(0, 10),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Player test failed:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'Player data fetching test failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Test user data fetching
app.get('/api/test/users', async (req, res) => {
  try {
    console.log('🧪 Testing user data fetching...');
    
    // Get active contests
    const contests = await databaseManager.getActiveContestsForRooms();
    console.log(`Found ${contests.length} active contests`);
    
    if (contests.length === 0) {
      return res.json({
        status: 'warning',
        message: 'No active contests found to test user fetching',
        contests: 0,
        timestamp: new Date().toISOString()
      });
    }
    
    // Test user fetching for first few contests
    const testResults = [];
    let totalUsers = 0;
    
    for (let i = 0; i < Math.min(contests.length, 3); i++) {
      const contest = contests[i];
      try {
        const users = await databaseManager.getContestUsers(contest.contest_id);
        testResults.push({
          contestId: contest.contest_id,
          expectedUsers: contest.user_count,
          actualUsers: users.length,
          users: users.map(u => ({
            username: u.username,
            email: u.email,
            userId: u.user_id,
            authId: u.auth_user_id
          }))
        });
        totalUsers += users.length;
      } catch (userError) {
        testResults.push({
          contestId: contest.contest_id,
          error: userError.message
        });
      }
    }
    
    res.json({
      status: 'success',
      message: 'User data fetching test completed',
      totalContests: contests.length,
      testedContests: testResults.length,
      totalUsersFound: totalUsers,
      testResults: testResults,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ User test failed:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'User data fetching test failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Redis-based API endpoints

// Get all players (for frontend to load player pool) - OPTIMIZED FOR PERFORMANCE
app.get('/api/players/pool', async (req, res) => {
  try {
    // Fetch players from database
    const rawPlayers = await databaseManager.getAllFantasyPlayers();
    console.log(`✅ Loading ${rawPlayers.length} players for frontend pool`);

    // Define the positions to be included in the draft
    const allowedPositions = ['QB', 'RB', 'WR', 'TE', 'K', 'CB', 'S', 'LB', 'DE', 'DT', 'ILB', 'OLB', 'FS', 'SS'];

    // Filter players by the allowed positions
    const filteredPlayers = rawPlayers.filter(player => allowedPositions.includes(player.Position));
    console.log(`✅ Filtered players to ${filteredPlayers.length} based on allowed positions`);

    // Return full player data for frontend display
    const optimizedPlayers = filteredPlayers.map(player => ({
      PlayerID: player.PlayerID,
      player_id: player.PlayerID, // For frontend compatibility
      Position: player.Position,
      Name: player.Name,
      Team: player.Team,
      TeamAbbr: player.TeamAbbr,
      Status: player.Status,
      JerseyNumber: player.JerseyNumber,
      FantasyPoints: player.FantasyPoints,
      FantasyPointsPPR: player.FantasyPointsPPR
    }));

    console.log(`✅ Optimized payload: ${filteredPlayers.length} players → ${JSON.stringify(optimizedPlayers).length} bytes`);

    // Return optimized player data
    res.json({
      success: true,
      players: optimizedPlayers,
      count: optimizedPlayers.length,
      message: `Successfully loaded ${optimizedPlayers.length} optimized players`
    });

  } catch (error) {
    console.error('Error loading player pool:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to load player pool',
      details: error.message 
    });
  }
});

// Get available players for a room
app.get('/api/room/:roomId/available-players', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { position } = req.query;
    
    const availablePlayers = await playerService.getAvailablePlayersWithDetails(roomId, position);
    
    res.json({
      roomId,
      position: position || 'all',
      count: availablePlayers.length,
      players: availablePlayers
    });
  } catch (error) {
    console.error('Error getting available players:', error);
    res.status(500).json({ error: 'Failed to get available players' });
  }
});

// Get picked players for a room
app.get('/api/room/:roomId/picked-players', async (req, res) => {
  try {
    const { roomId } = req.params;
    
    const pickedPlayers = await playerService.getPickedPlayersWithDetails(roomId);
    
    res.json({
      roomId,
      count: pickedPlayers.length,
      picks: pickedPlayers
    });
  } catch (error) {
    console.error('Error getting picked players:', error);
    res.status(500).json({ error: 'Failed to get picked players' });
  }
});

// Pick a player using Redis
app.post('/api/room/:roomId/pick-player', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { playerId, userId, username, round, pickNumber } = req.body;
    
    if (!playerId || !userId || !username) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Validate player exists
    if (!playerService.validatePlayer(playerId)) {
      return res.status(400).json({ error: 'Invalid player ID' });
    }
    
    // Check if player is available
    const isAvailable = await redisDraftService.isPlayerAvailable(roomId, playerId);
    if (!isAvailable) {
      return res.status(400).json({ error: 'Player is not available' });
    }
    
    // Pick the player atomically
    const result = await redisDraftService.pickPlayer(
      roomId, 
      playerId, 
      userId, 
      username, 
      round || 1, 
      pickNumber || 1
    );
    
    // Get the picked player details
    const player = playerService.getPlayerById(playerId);
    
    // Publish to Ably for real-time updates (OPTIMIZED - minimal data only)
    try {
      if (ably) {
        const channel = ably.channels.get(`draft-room-${roomId}`);
        
        // Get updated room stats from Redis
        const roomStats = await redisDraftService.getRoomStats(roomId);
        const availablePlayers = await redisDraftService.getAvailablePlayers(roomId);
        const pickedPlayers = await redisDraftService.getPickedPlayers(roomId);
        
        // OPTIMIZATION: Send only essential player data (reduces payload by ~70%)
        const optimizedPlayer = {
          PlayerID: player.PlayerID,
          Name: player.Name,
          Position: player.Position
        };
        
        // Publish player picked event with minimal data and comprehensive stats (RATE LIMITED)
        await publishWithServerRateLimit(channel, 'player-picked', {
          player: optimizedPlayer, // Only essential fields
          pickedBy: username,
          userId: userId,
          round: round || 1,
          pickNumber: pickNumber || 1,
          timestamp: new Date().toISOString(),
          source: 'redis-api-optimized',
          stats: {
            totalPlayers: roomStats.totalPlayers || 0,
            availablePlayers: availablePlayers.length,
            pickedPlayers: pickedPlayers.length,
            currentRound: roomStats.currentRound || 1,
            maxRounds: roomStats.maxRounds || 15,
            pickProgress: `${pickedPlayers.length}/${roomStats.totalPlayers || 0}`,
            roundProgress: `${roomStats.currentRound || 1}/${roomStats.maxRounds || 15}`
          }
        });
        
        console.log(`✅ Published OPTIMIZED player pick to Ably (${JSON.stringify(optimizedPlayer).length} bytes, RATE LIMITED)`);
      } else {
        console.log(`🔄 Ably not available - skipping real-time update for room ${roomId}`);
      }
      
    } catch (ablyError) {
      console.error('❌ Error publishing to Ably:', ablyError.message);
      console.log(`🔄 Continuing without real-time update for room ${roomId}`);
    }
    
    res.json({
      success: true,
      message: 'Player picked successfully',
      pick: {
        ...result,
        player: player
      }
    });
  } catch (error) {
    console.error('Error picking player:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all players (for frontend to load player pool) - FROM DATABASE


// Get room statistics
app.get('/api/room/:roomId/stats', async (req, res) => {
  try {
    const { roomId } = req.params;
    
    const stats = await redisDraftService.getRoomStats(roomId);
    
    res.json({
      roomId,
      stats
    });
  } catch (error) {
    console.error('Error getting room stats:', error);
    res.status(500).json({ error: 'Failed to get room stats' });
  }
});

// Get room draft summary
app.get('/api/room/:roomId/summary', async (req, res) => {
  try {
    const { roomId } = req.params;
    
    const summary = await playerService.getRoomDraftSummary(roomId);
    
    if (!summary) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    res.json({
      roomId,
      summary
    });
  } catch (error) {
    console.error('Error getting room summary:', error);
    res.status(500).json({ error: 'Failed to get room summary' });
  }
});

// Get auto-pick suggestions
app.get('/api/room/:roomId/auto-pick-suggestions', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, userSelections } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    const selections = userSelections ? JSON.parse(userSelections) : [];
    const suggestions = await playerService.getAutoPickSuggestions(roomId, userId, selections);
    
    res.json({
      roomId,
      userId,
      suggestions
    });
  } catch (error) {
    console.error('Error getting auto-pick suggestions:', error);
    res.status(500).json({ error: 'Failed to get auto-pick suggestions' });
  }
});

// Get room users from Redis
app.get('/api/room/:roomId/users', async (req, res) => {
  try {
    const { roomId } = req.params;
    
    if (!roomId) {
      return res.status(400).json({ error: 'Room ID is required' });
    }
    
    const users = await redisDraftService.getRoomUsers(roomId);
    
    res.json({
      roomId,
      users,
      userCount: users.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting room users from Redis:', error);
    res.status(500).json({ error: 'Failed to get room users' });
  }
});

// Search players
app.get('/api/players/search', (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    
    if (!q) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    
    const results = playerService.searchPlayersByName(q, parseInt(limit));
    
    res.json({
      query: q,
      count: results.length,
      players: results
    });
  } catch (error) {
    console.error('Error searching players:', error);
    res.status(500).json({ error: 'Failed to search players' });
  }
});

// Get player statistics
app.get('/api/players/stats', (req, res) => {
  try {
    const stats = playerService.getPlayerStats();
    
    res.json({
      stats
    });
  } catch (error) {
    console.error('Error getting player stats:', error);
    res.status(500).json({ error: 'Failed to get player stats' });
  }
});

// Get room information including host status and stats (bypasses Ably)
app.get('/api/room/:roomId/info', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { clientId } = req.query;

    const room = rooms[roomId];
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    // Determine host status
    let isHost = false;
    if (clientId) {
      // If no host is set, make the first user the host
      if (!room.hostId && room.users.length > 0) {
        room.hostId = room.users[0].id;
      }
      isHost = clientId === room.hostId;
    }

    // Get Redis stats
    let redisStats = {};
    try {
      const roomStats = await redisDraftService.getRoomStats(roomId);
      const availablePlayers = await redisDraftService.getAvailablePlayers(roomId);
      const pickedPlayers = await redisDraftService.getPickedPlayers(roomId);
      
      redisStats = {
        totalPlayers: roomStats.totalPlayers || 0,
        availablePlayers: availablePlayers.length,
        pickedPlayers: pickedPlayers.length,
        currentRound: roomStats.currentRound || 1,
        maxRounds: roomStats.maxRounds || 15,
        pickProgress: `${pickedPlayers.length}/${roomStats.totalPlayers || 0}`,
        roundProgress: `${roomStats.currentRound || 1}/${roomStats.maxRounds || 15}`
      };
    } catch (redisError) {
      console.error('Error getting Redis stats:', redisError);
      // Continue without Redis stats
    }

    res.json({
      roomId,
      isHost,
      hostId: room.hostId,
      users: room.users,
      started: room.started,
      userCount: room.users.length,
      createdAt: room.createdAt,
      currentRound: room.draftRound || 1,
      selectionPhase: room.selectionPhase || 'main',
      maxRounds: room.maxRounds || 15,
      stats: redisStats
    });
  } catch (error) {
    console.error('Error getting room info:', error);
    res.status(500).json({ error: 'Failed to get room info' });
  }
});

// Redis health check
app.get('/api/redis/health', async (req, res) => {
  try {
    const health = await redisDraftService.healthCheck();
    
    res.json({
      redis: health,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error checking Redis health:', error);
    res.status(500).json({ error: 'Failed to check Redis health' });
  }
});

// Contest monitoring endpoints
app.post('/api/contests/check', async (req, res) => {
  try {
    console.log('🔄 Manual contest check triggered via API');
    await checkAndCreateRoomsForContests();
    
    res.json({
      success: true,
      message: 'Contest check completed',
      timestamp: new Date().toISOString(),
      processedContests: lastCheckedContests.size
    });
  } catch (error) {
    console.error('Error in manual contest check:', error);
    res.status(500).json({ error: 'Failed to check contests' });
  }
});

// Get all contest rooms
app.get('/api/contests/rooms', (req, res) => {
  try {
    const contestRooms = Object.entries(rooms)
      .filter(([roomId, room]) => room.contestId)
      .map(([roomId, room]) => ({
        roomId,
        contestId: room.contestId,
        contestName: room.contestName,
        contestData: room.contestData,
        userCount: room.users.length,
        started: room.started,
        createdAt: room.createdAt,
        currentRound: room.draftRound || 1,
        maxRounds: room.maxRounds || 15
      }));
    
    res.json({
      success: true,
      contestRooms,
      totalContestRooms: contestRooms.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting contest rooms:', error);
    res.status(500).json({ error: 'Failed to get contest rooms' });
  }
});

// Get contest monitoring status
app.get('/api/contests/status', (req, res) => {
  try {
    res.json({
      success: true,
      monitoringActive: contestMonitoringInterval !== null,
      lastCheckedContests: Array.from(lastCheckedContests),
      totalProcessedContests: lastCheckedContests.size,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting contest status:', error);
    res.status(500).json({ error: 'Failed to get contest status' });
  }
});

// Start/Stop contest monitoring
app.post('/api/contests/monitoring', (req, res) => {
  try {
    const { action } = req.body;
    
    if (action === 'start') {
      startContestMonitoring();
      res.json({
        success: true,
        message: 'Contest monitoring started',
        timestamp: new Date().toISOString()
      });
    } else if (action === 'stop') {
      stopContestMonitoring();
      res.json({
        success: true,
        message: 'Contest monitoring stopped',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(400).json({ error: 'Invalid action. Use "start" or "stop"' });
    }
  } catch (error) {
    console.error('Error managing contest monitoring:', error);
    res.status(500).json({ error: 'Failed to manage contest monitoring' });
  }
});

// Get detailed contest information
app.get('/api/contests/info', async (req, res) => {
  try {
    const contests = await databaseManager.getTodayContests();
    
    const contestInfo = contests.map(contest => ({
      contestId: contest.contest_id || contest.id,
      contestName: contest.contest_name || 'Unnamed Contest',
      status: contest.contest_status,
      startTime: contest.start_time,
      endTime: contest.end_time,
      gameIds: contest.game_ids || [],
      hasRoom: lastCheckedContests.has(contest.contest_id || contest.id)
    }));
    
    res.json({
      success: true,
      contests: contestInfo,
      totalContests: contests.length,
      processedContests: lastCheckedContests.size,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting contest info:', error);
    res.status(500).json({ error: 'Failed to get contest info' });
  }
});

// Auto-pick control endpoints
app.get('/api/auto-pick/status', (req, res) => {
  try {
    const autoPickStatus = Array.from(autoPickTimers.entries()).map(([roomId, timer]) => ({
      roomId,
      hasTimer: !!timer,
      room: rooms[roomId] ? {
        contestId: rooms[roomId].contestId,
        contestName: rooms[roomId].contestName,
        userCount: rooms[roomId].users.length,
        started: rooms[roomId].started,
        currentRound: rooms[roomId].draftRound || 1,
        maxRounds: rooms[roomId].maxRounds || 15
      } : null
    }));
    
    res.json({
      success: true,
      autoPickStatus,
      totalRoomsWithAutoPick: autoPickStatus.length,
      config: {
        delayMinutes: AUTO_PICK_DELAY_MINUTES,
        intervalSeconds: AUTO_PICK_INTERVAL_SECONDS
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting auto-pick status:', error);
    res.status(500).json({ error: 'Failed to get auto-pick status' });
  }
});

// Start auto-pick for a specific room
app.post('/api/auto-pick/start/:roomId', (req, res) => {
  try {
    const { roomId } = req.params;
    const room = rooms[roomId];
    
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    startAutoPickTimer(roomId, room);
    
    res.json({
      success: true,
      message: `Auto-pick timer started for room ${roomId}`,
      roomId,
      delayMinutes: AUTO_PICK_DELAY_MINUTES,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error starting auto-pick:', error);
    res.status(500).json({ error: 'Failed to start auto-pick' });
  }
});

// Stop auto-pick for a specific room
app.post('/api/auto-pick/stop/:roomId', (req, res) => {
  try {
    const { roomId } = req.params;
    
    stopAutoPicking(roomId);
    
    res.json({
      success: true,
      message: `Auto-pick stopped for room ${roomId}`,
      roomId,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error stopping auto-pick:', error);
    res.status(500).json({ error: 'Failed to stop auto-pick' });
  }
});

function startTurn(roomId, rooms) {
  const room = rooms[roomId];
  if (!room || !room.started) return;

  const currentTurnOrder = getCurrentTurnOrder(room);
  const currentTurnUserId = getCurrentTurnUserId(room);
  const currentUser = room.users.find(u => u.id === currentTurnUserId);

  if (!currentUser) {
    console.log(`❌ User not found for turn ${room.currentTurnIndex} in round ${room.draftRound}`);
    return;
  }

  console.log(`🎯 SNAKE DRAFT: Round ${room.draftRound}, Turn ${room.currentTurnIndex + 1}/${currentTurnOrder.length}`);
  console.log(`🎯 ${currentUser.username}'s turn in room ${roomId}`);
  console.log(`🎯 Current turn order: ${currentTurnOrder.map(id => {
    const user = room.users.find(u => u.id === id);
    return user ? user.username : id;
  }).join(' → ')}`);

  // Check if user is connected
  const isConnected = room.users.find(u => u.id === currentTurnUserId && u.isConnected);
  if (!isConnected) {
    console.log(`⏰ User ${currentUser.username} is not connected - auto-picking after ${AUTO_PICK_INTERVAL_SECONDS} seconds`);
    setTimeout(() => {
      performAutoPick(roomId, room);
    }, AUTO_PICK_INTERVAL_SECONDS * 1000);
    return;
  }

  // Set turn timer for connected users
  let timeLeft = AUTO_PICK_INTERVAL_SECONDS;
  if (room.turnTimer) {
    clearInterval(room.turnTimer);
  }
  room.turnTimer = setInterval(() => {
    timeLeft--;
    if (timeLeft <= 0) {
      clearInterval(room.turnTimer);
      room.turnTimer = null;
      console.log(`⏰ Time's up for ${currentUser.username} - auto-picking`);
      performAutoPick(roomId, room);
    }
  }, 1000);

  // Publish turn started event
  const channel = ably.channels.get(`draft-room-${roomId}`);
  channel.publish("turn-started", {
    currentUser: currentUser.username,
    timeLeft: AUTO_PICK_INTERVAL_SECONDS,
    userId: currentTurnUserId,
    draftRound: room.draftRound,
    currentTurnIndex: room.currentTurnIndex,
    turnOrder: currentTurnOrder.map(id => {
      const user = room.users.find(u => u.id === id);
      return user ? user.username : null;
    }).filter(Boolean)
  });
}