const Ably = require('ably');
const fs = require('fs');
const path = require('path');

// Add fallback mode flag
let ablyFallbackMode = false;
let ablyConnectionFailed = false;

// Rate limiting mechanism
let messageQueue = [];
let isProcessingQueue = false;
let lastMessageTime = 0;
const MIN_MESSAGE_INTERVAL = 100; // Minimum 100ms between messages
const MAX_MESSAGES_PER_SECOND = 40; // Conservative limit

// Initialize Ably with better error handling
let ably;
try {
  ably = new Ably.Realtime({
    key: process.env.ABLY_API_KEY || 'E_U1fw.iYMzEg:KNoWxsCQgLnZ9_oeCL3VWU0NUD3wUB_nbO2rVez2WnA',
    endpoint: 'https://rest.ably.io',
    timeout: 10000, // Reduced timeout
    httpMaxRetryCount: 2, // Reduced retries
    fallbackHosts: ['a.ably-realtime.com', 'b.ably-realtime.com'],
    disconnectedRetryTimeout: 5000, // Reduced retry timeout
    suspendedRetryTimeout: 10000, // Reduced suspended retry
    closeOnUnload: true
  });

  // Handle connection events
  ably.connection.on('connected', () => {
    console.log('✅ Ably connected successfully');
    ablyFallbackMode = false;
    ablyConnectionFailed = false;
  });

  ably.connection.on('failed', (err) => {
    console.error('❌ Ably connection failed:', err.message);
    ablyConnectionFailed = true;
    ablyFallbackMode = true;
  });

  ably.connection.on('disconnected', () => {
    console.log('🔌 Ably disconnected');
  });

  ably.connection.on('suspended', () => {
    console.log('⏸ Ably suspended - switching to fallback mode');
    ablyFallbackMode = true;
  });

} catch (error) {
  console.error('❌ Failed to initialize Ably:', error.message);
  ablyFallbackMode = true;
  ablyConnectionFailed = true;
}

// Rate-limited publish function
async function publishWithRateLimit(channel, eventName, data) {
  if (ablyFallbackMode || ablyConnectionFailed) {
    console.log(`🔄 Fallback mode: Skipping Ably publish for ${eventName}`);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const message = { channel, eventName, data, resolve };
    messageQueue.push(message);
    
    if (!isProcessingQueue) {
      processMessageQueue();
    }
  });
}

// Process message queue with rate limiting
async function processMessageQueue() {
  if (isProcessingQueue || messageQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;

  while (messageQueue.length > 0) {
    const now = Date.now();
    const timeSinceLastMessage = now - lastMessageTime;

    if (timeSinceLastMessage < MIN_MESSAGE_INTERVAL) {
      await new Promise(resolve => setTimeout(resolve, MIN_MESSAGE_INTERVAL - timeSinceLastMessage));
    }

    const message = messageQueue.shift();
    try {
      await message.channel.publish(message.eventName, message.data);
      lastMessageTime = Date.now();
      console.log(`📡 Rate-limited publish: ${message.eventName}`);
      message.resolve();
    } catch (error) {
      console.error(`❌ Rate-limited publish failed for ${message.eventName}:`, error.message);
      if (error.code === 42911) {
        // Rate limit exceeded - pause for longer
        console.log('⏸ Rate limit hit, pausing for 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Put message back at front of queue
        messageQueue.unshift(message);
      } else {
        ablyFallbackMode = true;
        message.resolve();
      }
    }
  }

  isProcessingQueue = false;
}

// Fallback publish function (legacy)
function publishWithFallback(channel, eventName, data) {
  return publishWithRateLimit(channel, eventName, data);
}

// Utility Functions - Simplified for essential events only
function publishEssentialEvent(channel, event, data) {
  return publishWithRateLimit(channel, event, data);
}

// Add publishChunked function to handle large data sets (RATE LIMITED)
function publishChunked(channel, eventName, data, chunkSize = 10, options = {}) {
  try {
    if (!Array.isArray(data) || data.length === 0) {
      console.log(`📡 Publishing ${eventName} (no data to chunk)`);
      return;
    }

    const totalChunks = Math.ceil(data.length / chunkSize);
    console.log(`📡 Publishing ${eventName} in ${totalChunks} chunks (${data.length} items) - RATE LIMITED`);

    // Process chunks with rate limiting
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, data.length);
      const chunk = data.slice(start, end);

      const message = {
        chunk,
        chunkIndex: i,
        totalChunks,
        ...options
      };

      // Use rate-limited publish
      publishWithRateLimit(channel, eventName, message);
    }
  } catch (error) {
    console.error(`❌ Error in publishChunked for ${eventName}:`, error);
  }
}

function getSelectionsWithUsernames(room) {
  const selectionsWithUsernames = {};
  for (const [userId, selections] of Object.entries(room.selections)) {
    const user = room.users.find(u => u.id === userId);
    if (user) {
      selectionsWithUsernames[user.username] = selections;
    }
  }
  return selectionsWithUsernames;
}

function getPositionCounts(userSelections) {
  const positionCounts = {
    QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, FLEX: 0
  };
  
  userSelections.forEach(player => {
    const pos = player.rosterPosition || player.Position;
    if (positionCounts.hasOwnProperty(pos)) {
      positionCounts[pos]++;
    }
  });
  
  return positionCounts;
}

function getOpenPositions(positionCounts, lineupConfig) {
  const openPositions = [];
  
  // Add positions that haven't met minDraftable requirement
  for (const posConfig of lineupConfig.positions) {
    const currentCount = positionCounts[posConfig.position] || 0;
    if (currentCount < posConfig.minDraftable) {
      openPositions.push(posConfig.position);
    }
  }
  
  // Add positions that can take more players up to maxDraftable
  for (const posConfig of lineupConfig.positions) {
    const currentCount = positionCounts[posConfig.position] || 0;
    if (currentCount < posConfig.maxDraftable && !openPositions.includes(posConfig.position)) {
      openPositions.push(posConfig.position);
    }
  }
  
  return openPositions;
}

function checkAllPreferencesSubmitted(room) {
  return room.users.length > 0 && room.users.every(user =>
    !!(room.preferredQueue[user.id] && room.preferredQueue[user.id].length > 0)
  );
}

// Snake Draft Helper Functions
function getCurrentTurnOrder(room) {
  if (!room || !room.turnOrder || room.turnOrder.length === 0) {
    return [];
  }
  
  // For odd rounds: normal order, For even rounds: reversed order
  if (room.draftRound % 2 === 1) {
    return [...room.turnOrder];
  } else {
    return [...room.turnOrder].reverse();
  }
}

function getCurrentTurnUserId(room) {
  const currentTurnOrder = getCurrentTurnOrder(room);
  if (currentTurnOrder.length === 0 || room.currentTurnIndex >= currentTurnOrder.length) {
    return null;
  }
  return currentTurnOrder[room.currentTurnIndex];
}

function getNextTurnUserId(room) {
  const currentTurnOrder = getCurrentTurnOrder(room);
  if (currentTurnOrder.length === 0) {
    return null;
  }
  const nextIndex = (room.currentTurnIndex + 1) % currentTurnOrder.length;
  return currentTurnOrder[nextIndex];
}

function advanceToNextTurn(room) {
  room.currentTurnIndex++;
  
  if (room.currentTurnIndex >= room.turnOrder.length) {
    room.draftRound++;
    room.currentTurnIndex = 0;
    console.log(`🔄 SNAKE DRAFT: Round ${room.draftRound} starting`);
    console.log(`🔄 Turn order for round ${room.draftRound}: ${getCurrentTurnOrder(room).join(' → ')}`);
  }
}

// Core Auto-Pick Logic - Corrected Implementation
function selectPlayerForUser(room, userId) {
  if (!room.pool || room.pool.length === 0) return null;

  console.log(`🤖 Starting auto-pick for user ${userId}`);
  console.log(`📊 Pool size: ${room.pool.length} players`);

  // For simplified auto-pick, just select the first available player
  // This is a simplified version that works with PlayerID, Position data only
  const selectedPlayer = room.pool[0];
  
  if (selectedPlayer) {
    console.log(`✅ Auto-selected player: ${selectedPlayer.PlayerID} (${selectedPlayer.Position})`);
    return selectedPlayer;
  } else {
    console.log(`❌ No players available in pool`);
    return null;
  }
}

// Game State Management FunctionspublishChunked
  function publishGameStateChunks(roomId, gameState, clientId) {
    const channel = ably.channels.get(`draft-room-${roomId}`);
  
    if (gameState.pool && Array.isArray(gameState.pool)) {
      publishChunked(channel, 'game-state-pool', gameState.pool, 10, clientId ? { targetClientId: clientId } : {});
    }
  
    if (gameState.selections && typeof gameState.selections === 'object') {
      const selectionEntries = Object.entries(gameState.selections);
      publishChunked(channel, 'game-state-selections', selectionEntries, 10, clientId ? { targetClientId: clientId } : {});
    }
  
    const { pool, selections, ...rest } = gameState;
    channel.publish('game-state-meta', { ...rest, clientId });
  }

function moveToNextTurn(roomId, rooms) {
  const room = rooms[roomId];
  if (!room) return;

  if (room.turnTimer) {
    clearInterval(room.turnTimer);
    room.turnTimer = null;
  }

  advanceToNextTurn(room);
  
  if (room.draftRound > room.maxRounds) {
    handleSelectionEnd(roomId, rooms);
    return;
  }
  
  const currentTurnOrder = getCurrentTurnOrder(room);
  const currentUser = getCurrentTurnUserId(room);
  console.log(`🔄 SNAKE DRAFT: Round ${room.draftRound}, Turn ${room.currentTurnIndex + 1}/${room.turnOrder.length}`);
  console.log(`🔄 Current turn order: ${currentTurnOrder.join(' → ')}`);
  console.log(`🔄 Current user: ${currentUser}`);

  setTimeout(() => {
    startTurn(roomId, rooms);
  }, 1000);
}

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

  const isDisconnected = !room.users.find(u => u.id === currentTurnUserId);
  if (isDisconnected) {
    console.log(`⏰ Auto-selecting for disconnected user ${currentUser.username}`);
    setTimeout(() => {
      autoSelectForDisconnectedUser(roomId, rooms, currentTurnUserId, currentUser.username);
    }, 10000);
    return;
  }

  let timeLeft = 10;
  if (room.turnTimer) {
    clearInterval(room.turnTimer);
  }
  room.turnTimer = setInterval(() => {
    timeLeft--;
    if (timeLeft <= 0) {
      clearInterval(room.turnTimer);
      room.turnTimer = null;
      autoSelectForDisconnectedUser(roomId, rooms, currentTurnUserId, currentUser.username);
    }
  }, 1000);

  const channel = ably.channels.get(`draft-room-${roomId}`);
  channel.publish("turn-started", {
    currentUser: currentUser.username,
    timeLeft: 10,
    userId: currentTurnUserId,
    draftRound: room.draftRound,
    currentTurnIndex: room.currentTurnIndex,
    turnOrder: currentTurnOrder.map(id => {
      const user = room.users.find(u => u.id === id);
      return user ? user.username : null;
    }).filter(Boolean)
  });
}

function autoSelectForDisconnectedUser(roomId, rooms, userId, username) {
  const room = rooms[roomId];
  if (!room) return;

  if (room.turnTimer) {
    clearInterval(room.turnTimer);
    room.turnTimer = null;
  }

  console.log(`🤖 Auto-selecting for ${username} in room ${roomId}`);

  const selection = selectPlayerForUser(room, userId);
  if (selection) {
    const channel = ably.channels.get(`draft-room-${roomId}`);
    publishChunked(channel, 'player-selected-pool', room.pool, 10);
    publishChunked(channel, 'player-selected-selections', Object.entries(getSelectionsWithUsernames(room)), 10);
    channel.publish('player-selected-meta', {
      player: selection,
      selectedBy: username,
      userId: userId,
      autoSelected: true,
      wasPreferred: selection.wasPreferred || false
    });

    if (selection.wasPreferred) {
      channel.publish("preferred-players-updated", {
        preferredPlayers: room.preferredQueue[userId] || [],
        message:` ${username} auto-selected their preferred player ${selection.PlayerID},
        userId: userId,
        username: username,
        autoSelected: true`
      });

      publishGameStateChunks(roomId, {
        turnOrder: room.started ?
          room.turnOrder
          .map((id) => {
            const user = room.users.find((u) => u.id === id);
            return user ? user.username : null;
          })
          .filter(Boolean) :
          [],
        currentTurnIndex: room.currentTurnIndex,
        pool: room.pool || [],
        selections: getSelectionsWithUsernames(room),
        started: room.started,
        selectionPhase: room.selectionPhase || 'main',
        preferredQueue: room.preferredQueue,
        maxMainPlayers: room.maxMainPlayers,
        maxBenchPlayers: room.maxBenchPlayers
      });
    }
  } else {
    console.log(`⚠ Could not auto-select any valid player for ${username}`);
    const channel = ably.channels.get(`draft-room-${roomId}`);
    channel.publish('auto-select-failed', {
      username: username,
      userId: userId,
      reason: 'No valid players available for any open roster position'
    });
  }
 
  moveToNextTurn(roomId, rooms);
}

function handleSelectionEnd(roomId, rooms) {
  const room = rooms[roomId];
  if (!room) return;

  console.log(`🏁 Draft completed for room ${roomId}`);

  const channel = ably.channels.get(`draft-room-${roomId}`);
  channel.publish("draft-completed", {
    selections: getSelectionsWithUsernames(room),
    finalPool: room.pool
  });
}

// Player Pool Generation
async function generatePlayerPool(callback) {
  if (playerPoolCache) {
    callback(playerPoolCache);
    return;
  }
  try {
    const { databaseManager } = require('./databaseManager');
    const players = await databaseManager.getAllFantasyPlayers();
    console.log(`✅ Loaded ${players.length} players from database`);

    // Define the positions to be included in the draft
    const allowedPositions = ['QB', 'RB', 'WR', 'TE', 'K', 'CB', 'S', 'LB', 'DE', 'DT', 'ILB', 'OLB', 'FS', 'SS'];

    // Filter players by the allowed positions
    const filteredPlayers = players.filter(player => allowedPositions.includes(player.Position));
    console.log(`✅ Filtered players to ${filteredPlayers.length} based on allowed positions`);

    // Group players by position for logging
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

    // Use ALL available players instead of limiting the pool (same as server.js)
    const pool = filteredPlayers;
   
    console.log(`✅ Created full pool with ${pool.length} players (same as server.js)`);
    playerPoolCache = pool;
    callback(pool);
  } catch (error) {
    console.error("❌ Error loading player data from database:", error.message);
    callback([]);
  }
}

// Main Ably Setup Function
function setupAbly(rooms) {
  console.log('Ably setup initialized');
 
  function publishToRoom(roomId, event, data) {
    const channel = ably.channels.get(`draft-room-${roomId}`);
    return channel.publish(event, data);
  }

  function getRoomChannel(roomId) {
    return ably.channels.get(`draft-room-${roomId}`);
  }

  // Handle room operations
  async function handleJoinRoom(roomId, username, clientId) {
    console.log('🔍 JOIN ROOM DEBUG:');
    console.log(`   Room ID received: "${roomId}"`);
    console.log(`   Username: "${username}"`);
    console.log(`   Client ID: "${clientId}"`);
    console.log(`   Available rooms: ${Object.keys(rooms)}`);
    console.log(`   Room exists: ${!!rooms[roomId]}`);
   
    if (!roomId || !username) {
      return { error: "Room ID and username are required" };
    }
 
    if (!rooms[roomId]) {
      console.log(`❌ Room ${roomId} not found. Cannot create room manually - rooms must be created from database.`);
      return { error: "Room not found. Rooms are created automatically from database contests." };
    }

    const room = rooms[roomId];

    if (!room.pool || room.pool.length === 0) {
      console.log('Generating player pool for room...');
      generatePlayerPool(async (pool) => {
        room.pool = pool;
        console.log(`Player pool generated with ${pool.length} players`);
        await finishJoinRoom();
      });
      return { status: 'generating_pool' };
    }
   
    return await finishJoinRoom();
   
    async function finishJoinRoom() {
      if (!room.preferredQueue) {
        room.preferredQueue = {};
      }
      if (!room.maxMainPlayers) {
        room.maxMainPlayers = 5;
      }
      if (!room.maxBenchPlayers) {
        room.maxBenchPlayers = 2;
      }

      // Check if this is a database-created room
      const isDatabaseRoom = room.source === 'database_contest';
      
      if (isDatabaseRoom) {
        console.log(`🏗️ Room ${roomId} was created from database contest ${room.contestId}`);
        
        // Verify user authorization with database
        const { databaseManager } = require('./databaseManager');
        const isAuthorized = await databaseManager.isUserAuthorizedForContest(username, room.contestId);
        
        if (!isAuthorized) {
          console.log(`❌ User ${username} is not authorized for contest ${room.contestId}`);
          return { error: "You are not authorized to join this contest. Please contact the contest administrator." };
        }
        
        // Get user contest details from database
        const userContestDetails = await databaseManager.getUserContestDetails(username, room.contestId);
        if (!userContestDetails) {
          console.log(`❌ Could not retrieve contest details for user ${username}`);
          return { error: "Unable to verify your contest participation. Please try again." };
        }
        
        // Find user in the pre-assigned database users
        const databaseUser = room.users.find(u => 
          u.username.toLowerCase() === username.toLowerCase() && 
          u.source === 'database'
        );
        
        if (databaseUser) {
          console.log(`✅ User ${username} found in database users for room ${roomId}`);
          
          // Update the database user with client connection info and contest details
          databaseUser.clientId = clientId;
          databaseUser.isConnected = true;
          databaseUser.lastConnected = new Date().toISOString();
          databaseUser.contestDetails = userContestDetails;
          
          // Update user in Redis
          const RedisDraftService = require('./redisDraftService');
          const redisDraftService = new RedisDraftService();
          await redisDraftService.addUserToRoom(roomId, databaseUser);
          
          // Initialize selections and preferences if not already set
          if (!room.selections[clientId]) {
            room.selections[clientId] = [];
          }
          if (!room.preferredQueue[clientId]) {
            room.preferredQueue[clientId] = [];
          }
          
          console.log(`✅ Database user ${username} successfully connected to room ${roomId}`);
          console.log(`📋 Contest: ${userContestDetails.contest_name} (${userContestDetails.contest_status})`);
        } else {
          console.log(`❌ User ${username} not found in database users for room ${roomId}`);
          console.log(`📋 Available database users: ${room.users.map(u => u.username).join(', ')}`);
          return { error: "Username not found in this contest. Only users assigned to this contest can join." };
        }
      } else {
        // Handle legacy room joining (for backward compatibility)
        console.log(`🔄 Room ${roomId} is a legacy room, using standard join logic`);
        
        const disconnectedUser = room.disconnectedUsers?.find(
          (u) => u.username.toLowerCase() === username.toLowerCase()
        );

        if (disconnectedUser) {
          console.log(`User ${username} reconnecting to room ${roomId}`);
          room.disconnectedUsers = room.disconnectedUsers.filter(
            (u) => u.username.toLowerCase() !== username.toLowerCase()
          );
          const user = { id: clientId, username: username.trim() };
          room.users.push(user);

          room.selections[clientId] = disconnectedUser.selections || [];
          room.preferredQueue[clientId] = disconnectedUser.preferredQueue || [];

          if (room.started && room.turnOrder.length > 0) {
            const turnIndex = room.turnOrder.findIndex(
              (oldId) => oldId === disconnectedUser.id
            );
            if (turnIndex !== -1) {
              room.turnOrder[turnIndex] = clientId;
              if (room.currentTurnIndex === turnIndex) {
                setTimeout(() => {
                  startTurn(roomId, rooms);
                }, 1000);
              }
            }
          }

          if (disconnectedUser.timeout) {
            clearTimeout(disconnectedUser.timeout);
          }
        } else {
          const existingUser = room.users.find(
            (u) => u.username.toLowerCase() === username.toLowerCase()
          );

          if (existingUser) {
            return { error: "Username already taken in this room" };
          }

          const user = { id: clientId, username: username.trim() };
          room.users.push(user);

          // Update user in Redis for legacy rooms
          const RedisDraftService = require('./redisDraftService');
          const redisDraftService = new RedisDraftService();
          await redisDraftService.addUserToRoom(roomId, user);

          room.selections[clientId] = [];
          room.preferredQueue[clientId] = [];

          if (!room.hostId) {
            room.hostId = clientId;
          }
        }
      }

      console.log(`📢 Broadcasting room users for room ${roomId}:`);
      const usersWithPreferences = room.users;
      console.log(`Users in room: ${usersWithPreferences.map(u => u.username).join(', ')}`);
     
      publishToRoom(roomId, "room-users", usersWithPreferences);
      publishToRoom(roomId, "disconnected-users", room.disconnectedUsers || []);
     
      const isHost = clientId === room.hostId;
      publishToRoom(roomId, "host-status", {
        isHost,
        started: room.started,
        clientId
      });

      const gameState = {
        turnOrder: room.started
          ? room.turnOrder
              .map((id) => {
                const user = room.users.find((u) => u.id === id);
                return user ? user.username : null;
              })
              .filter(Boolean)
          : [],
        currentTurnIndex: room.currentTurnIndex,
        pool: room.pool || [],
        selections: getSelectionsWithUsernames(room),
        started: room.started,
        selectionPhase: room.selectionPhase || 'main',
        preferredQueue: room.preferredQueue,
        maxMainPlayers: room.maxMainPlayers,
        maxBenchPlayers: room.maxBenchPlayers
      };
      publishGameStateChunks(roomId, gameState, clientId);

      const { pool, selections, ...gameStateMeta } = gameState;
      publishToRoom(roomId, "game-state", {
        ...gameStateMeta,
        preferredQueue: room.preferredQueue[clientId] || [],
        clientId
      });

      console.log(`✅ User ${username} successfully joined room ${roomId}`);
      return {
        status: 'success',
        roomId,
        username,
        isHost,
        gameState: {
          ...gameState,
          preferredQueue: room.preferredQueue[clientId] || []
        }
      };
    }
  }

  // Handle setting preferred players
  function handleSetPreferredPlayers(roomId, clientId, preferredPlayers) {
    const room = rooms[roomId];
    if (!room) {
      return { error: "Room not found" };
    }

    if (!Array.isArray(preferredPlayers)) {
      return { error: "Preferred players must be an array" };
    }

    console.log(`🔍 Backend: Received ${preferredPlayers.length} preferred players:, preferredPlayers`);
    console.log(`🔍 Backend: Pool has ${room.pool.length} players`);

    const userSelections = room.selections[clientId] || [];
    const selectedPlayerIds = userSelections.map(p => p.PlayerID);

    const validPreferredPlayers = preferredPlayers.filter((playerId, index) => {
      const isValidType = typeof playerId === 'number';
      const isInPool = room.pool.some(p => p.PlayerID === playerId);
      const isInSelections = selectedPlayerIds.includes(playerId);
      
      console.log(`🔍 Backend: Player ${playerId}: isValidType=${isValidType}, isInPool=${isInPool}, isInSelections=${isInSelections}`);
      
      // Keep players that are either in the pool OR in the user's selections (selected players)
      return isValidType && (isInPool || isInSelections);
    });

    console.log(`🔍 Backend: Filtered to ${validPreferredPlayers.length} valid players:, validPreferredPlayers`);

    room.preferredQueue[clientId] = validPreferredPlayers;

    const user = room.users.find(u => u.id === clientId);
    console.log(`📝 User ${user?.username} updated preferred players during draft: ${validPreferredPlayers.join(', ')}`);

    publishToRoom(roomId, "preferred-players-updated", {
      preferredPlayers: validPreferredPlayers,
      message: `${user.username} updated their preferences${room.started ? ' during draft' : ''}.,
      userId: clientId,
      username: user.username,
      duringDraft: room.started`
    });

    const usersWithPreferences = room.users;
    publishToRoom(roomId, "room-users", usersWithPreferences);

    publishGameStateChunks(roomId, {
      turnOrder: room.started ?
        room.turnOrder
        .map((id) => {
          const user = room.users.find((u) => u.id === id);
          return user ? user.username : null;
        })
        .filter(Boolean) :
        [],
      currentTurnIndex: room.currentTurnIndex,
      pool: room.pool || [],
      selections: getSelectionsWithUsernames(room),
      started: room.started,
      selectionPhase: room.selectionPhase || 'main',
      preferredQueue: room.preferredQueue,
      maxMainPlayers: room.maxMainPlayers,
      maxBenchPlayers: room.maxBenchPlayers
    }, clientId);

    return { status: 'success' };
  }

  // Handle starting the draft
  function handleStartDraft(roomId, clientId) {
    console.log('[Ably] handleStartDraft called with:', { roomId, clientId });
    const room = rooms[roomId];
    if (!room) {
      console.log('[Ably] Room not found:', roomId);
      return { error: "Room not found" };
    }

    console.log('[Ably] Room hostId:', room.hostId, 'Users:', room.users.map(u => u.id));
    if (clientId !== room.hostId) {
      console.log('[Ably] Not host:', clientId, 'Host is:', room.hostId);
      return { error: "Only host can start the draft" };
    }

    if (room.users.length < 2) {
      console.log('[Ably] Not enough users:', room.users.length);
      return { error: "Need at least 2 players to start" };
    }

    room.started = true;
    room.turnOrder = room.users.map(u => u.id);
    room.currentTurnIndex = 0;
    room.draftRound = 1;
    room.selectionPhase = 'main';

    console.log(`🚀 SNAKE DRAFT started for room ${roomId}`);
    console.log(`Initial turn order (Round 1): ${room.turnOrder.map(id => {
      const user = room.users.find(u => u.id === id);
      return user ? user.username : id;
    }).join(' → ')}`);

    publishChunked(ably.channels.get(`draft-room-${roomId}`), 'draft-started-pool', room.pool, 10);
    
    const currentTurnOrder = getCurrentTurnOrder(room);
    publishToRoom(roomId, 'draft-started-meta', {
      turnOrder: currentTurnOrder.map(id => {
        const user = room.users.find(u => u.id === id);
        return user ? user.username : null;
      }).filter(Boolean),
      currentUser: room.users.find(u => u.id === currentTurnOrder[0])?.username,
      selectionPhase: room.selectionPhase,
      draftRound: room.draftRound
    });

    setTimeout(() => {
      startTurn(roomId, rooms);
    }, 1000);

    return { status: 'success' };
  }

  // Handle player selection
function handleSelectPlayer(roomId, clientId, playerID) {
  const room = rooms[roomId];
  if (!room) {
    console.log(`[select-player] Room not found: roomId=${roomId}`);
    return { error: "Room not found" };
  }

  if (!room.started) {
    console.log(`[select-player] Draft has not started yet: roomId=${roomId}`);
    return { error: "Draft has not started yet" };
  }

  const currentTurnUserId = getCurrentTurnUserId(room);
  if (clientId !== currentTurnUserId) {
    console.log(`[select-player] Not your turn: clientId=${clientId}, expected=${currentTurnUserId}`);
    console.log(`[select-player] Current turn order: ${getCurrentTurnOrder(room).map(id => {
      const user = room.users.find(u => u.id === id);
      return user ? user.username : id;
    }).join(' → ')}`);
    return { error: "It's not your turn" };
  }

  const playerIndex = room.pool.findIndex(p => p.PlayerID === playerID);
  if (playerIndex === -1) {
    console.log(`[select-player] Player not found in pool: playerID=${playerID}, poolSize=${room.pool.length}`);
    return { error: "Player not found in pool" };
  }

  const player = room.pool[playerIndex];
  const user = room.users.find(u => u.id === clientId);

  const preferredQueue = room.preferredQueue[clientId] || [];
  const isPreferred = preferredQueue.includes(playerID);
 
  if (isPreferred) {
            console.log(`🌟 Player ${player.PlayerID} found in ${user.username}'s preference list - keeping in preferences`);
    // Keep the player in the preference list - don't remove them
    // This allows the preference list to remain visible throughout the draft
  } else {
            console.log(`📋 Player ${player.PlayerID} selected from main pool by ${user.username}`);
  }

  const userSelections = room.selections[clientId] || [];
  const lineupConfig = require('../config/lineupConfigs.json')[0];
  const { isDraftValid } = require('../utils/isDraftValid');
  const validation = isDraftValid(userSelections, player, lineupConfig);
 
  if (!validation.valid || validation.position === 'N/A') {
            console.log(`❌ Invalid selection: ${player.PlayerID} would result in N/A position for ${user.username}`);
        return { error: `No valid roster position available for ${player.PlayerID}. This would result in an invalid lineup.` };
  }
 
  player.rosterPosition = validation.position;

  if (!room.selections[clientId]) {
    room.selections[clientId] = [];
  }
  room.selections[clientId].push(player);

  room.pool.splice(playerIndex, 1);

              console.log(`🎯 ${user.username} selected ${player.PlayerID} (${player.Position}) -> ${player.rosterPosition}${isPreferred ? ' [PREFERRED]' : ''}`);
    console.log(`📋 Preference queue after selection: ${JSON.stringify(room.preferredQueue[clientId] || [])}`);

    const channel = ably.channels.get(`draft-room-${roomId}`);
    publishChunked(channel, 'player-selected-pool', room.pool, 10);
    publishChunked(channel, 'player-selected-selections', Object.entries(getSelectionsWithUsernames(room)), 10);
    channel.publish('player-selected-meta', {
      player,
      selectedBy: user.username,
      userId: clientId,
      autoSelected: false,
      wasPreferred: isPreferred
    });

  publishToRoom(roomId, "preferred-players-updated", {
    preferredPlayers: room.preferredQueue[clientId] || [],
    message: isPreferred ? `${user.username} selected their preferred player ${player.PlayerID}` : `${user.username} selected ${player.PlayerID}`,
    userId: clientId,
    username: user.username
  });

  moveToNextTurn(roomId, rooms);

  return { status: 'success' };
}

  // Handle auto-pick player
  function handleAutoPickPlayer(roomId, clientId) {
    const room = rooms[roomId];
    if (!room) {
      console.log(`[auto-pick] Room not found: roomId=${roomId}`);
      return { error: "Room not found" };
    }

    if (!room.started) {
      console.log(`[auto-pick] Draft has not started yet: roomId=${roomId}`);
      return { error: "Draft has not started yet" };
    }

  const currentTurnUserId = getCurrentTurnUserId(room);
  if (clientId !== currentTurnUserId) {
    console.log(`[auto-pick] Not your turn: clientId=${clientId}, expected=${currentTurnUserId}`);
    return { error: "It's not your turn" };
  }

    const user = room.users.find(u => u.id === clientId);
    if (!user) {
      return { error: "User not found" };
    }

    console.log(`🤖 Manual auto-pick requested by ${user.username} in room ${roomId}`);

    const selection = selectPlayerForUser(room, clientId);
   
    if (selection) {
      console.log(`✅ Auto-pick successful: ${user.username} auto-selected ${selection.PlayerID} (${selection.Position}) -> ${selection.rosterPosition}`);
     
      const channel = ably.channels.get(`draft-room-${roomId}`);
      publishChunked(channel, 'player-selected-pool', room.pool, 10);
      publishChunked(channel, 'player-selected-selections', Object.entries(getSelectionsWithUsernames(room)), 10);
      channel.publish('player-selected-meta', {
        player: selection,
        selectedBy: user.username,
        userId: clientId,
        autoSelected: true,
        wasPreferred: selection.wasPreferred || false,
        autoPickSource: selection.autoPickSource || 'unknown'
      });

      if (selection.wasPreferred) {
        channel.publish("preferred-players-updated", {
          preferredPlayers: room.preferredQueue[clientId] || [],
          message: `${user.username} auto-selected their preferred player ${selection.PlayerID}`,
          userId: clientId,
          username: user.username,
          autoSelected: true
        });

        publishGameStateChunks(roomId, {
          turnOrder: room.started ?
            room.turnOrder
            .map((id) => {
              const user = room.users.find((u) => u.id === id);
              return user ? user.username : null;
            })
            .filter(Boolean) :
            [],
          currentTurnIndex: room.currentTurnIndex,
          pool: room.pool || [],
          selections: getSelectionsWithUsernames(room),
          started: room.started,
          selectionPhase: room.selectionPhase || 'main',
          preferredQueue: room.preferredQueue,
          maxMainPlayers: room.maxMainPlayers,
          maxBenchPlayers: room.maxBenchPlayers
        });
      }

      moveToNextTurn(roomId, rooms);

      return {
        status: 'success',
        message: `Auto-picked ${selection.PlayerID} (${selection.Position})`,
        selection: {
          player: selection,
          wasPreferred: selection.wasPreferred,
          source: selection.autoPickSource
        }
      };
    } else {
      console.log(`❌ Auto-pick failed for ${user.username}: no valid players available`);
     
      const channel = ably.channels.get(`draft-room-${roomId}`);
      channel.publish('auto-select-failed', {
        username: user.username,
        userId: clientId,
        reason: 'No valid players available for any open roster position'
      });

      moveToNextTurn(roomId, rooms);

      return {
        status: 'success',
        message: 'Auto-pick completed - no valid players available',
        selection: null
      };
    }
  }

  // Handle disconnection
  function handleDisconnect(roomId, clientId) {
    const room = rooms[roomId];
    if (!room) return { error: 'Room not found' };

    const user = room.users.find(u => u.id === clientId);
    if (!user) return { error: 'User not found' };

    console.log(`🔌 User ${user.username} disconnected from room ${roomId}`);

    room.users = room.users.filter(u => u.id !== clientId);

    if (!room.started && Array.isArray(room.turnOrder)) {
      room.turnOrder = room.turnOrder.filter(id => id !== clientId);
    }

    const disconnectedUser = {
      id: clientId,
      username: user.username,
      selections: room.selections[clientId] || [],
      preferredQueue: room.preferredQueue[clientId] || [],
      disconnectedAt: new Date().toISOString()
    };

    room.disconnectedUsers.push(disconnectedUser);

    if (room.started) {
      const turnIndex = room.turnOrder.findIndex(id => id === clientId);
      if (turnIndex !== -1 && turnIndex === room.currentTurnIndex) {
        const timeout = setTimeout(() => {
          autoSelectForDisconnectedUser(roomId, rooms, clientId, user.username);
        }, 30000);
        disconnectedUser.timeout = timeout;
      }
    }

    if (room.hostId === clientId && room.users.length > 0) {
      room.hostId = room.users[0].id;
      publishToRoom(roomId, "host-status", {
        isHost: true,
        started: room.started,
        clientId: room.hostId
      });
    }

    const usersWithPreferences = room.users;
    publishToRoom(roomId, "room-users", usersWithPreferences);
    publishToRoom(roomId, "disconnected-users", room.disconnectedUsers);

    return { status: 'success' };
  }

  return {
    handleJoinRoom,
    handleSetPreferredPlayers,
    handleStartDraft,
    handleSelectPlayer,
    handleAutoPickPlayer,
    handleDisconnect,
    publishToRoom,
    getRoomChannel
  };
}

module.exports = { setupAbly, getCurrentTurnOrder, getCurrentTurnUserId, selectPlayerForUser };