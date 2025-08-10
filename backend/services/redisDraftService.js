const Redis = require('redis');
const { promisify } = require('util');
const { databaseManager } = require('./databaseManager');

class RedisDraftService {
  constructor() {
    this.redis = null;
    this.isConnected = false;
    this.writeQueue = []; // Queue for writes during Redis outages
    // Construct Redis URL from individual environment variables or use REDIS_URL
    if (process.env.REDIS_URL) {
      this.connectionString = process.env.REDIS_URL;
    } else if (process.env.REDIS_HOST && process.env.REDIS_PORT) {
      const protocol = process.env.REDIS_TLS === 'true' ? 'rediss://' : 'redis://';
      const password = process.env.REDIS_PASSWORD ? `:${process.env.REDIS_PASSWORD}@` : '';
      this.connectionString = `${protocol}${password}${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`;
    } else {
      // Default to localhost Redis for development
      this.connectionString = 'redis://localhost:6379';
    }
    this.databaseManager = databaseManager; // Database integration
    this.lastCacheUpdate = 0; // Track when cache was last updated
    this.cacheUpdateInterval = 5 * 60 * 1000; // 5 minutes cache refresh
    
    // Auto-connect to Redis on initialization
    console.log(`🔌 Redis connection string: ${this.connectionString.replace(/:[^:@]*@/, ':****@')}`); // Hide password in logs
    this.initialize();
    
    // Lua scripts for atomic operations
    this.luaScripts = {
      pickPlayer: `
        local roomId = KEYS[1]
        local playerId = ARGV[1]
        local userId = ARGV[2]
        local username = ARGV[3]
        local timestamp = ARGV[4]
        local round = ARGV[5]
        local pickNumber = ARGV[6]
        
        -- Check if player is already picked in this room
        local isPicked = redis.call('SISMEMBER', 'draft:room:' .. roomId .. ':picked_ids', playerId)
        if isPicked == 1 then
          return {err = 'Player already picked'}
        end
        
        -- Check if player exists in master list
        local existsInMaster = redis.call('SISMEMBER', 'draft:master_list', playerId)
        if existsInMaster == 0 then
          return {err = 'Player not found in master list'}
        end
        
        -- Add player to picked set
        redis.call('SADD', 'draft:room:' .. roomId .. ':picked_ids', playerId)
        
        -- Store pick metadata
        local pickKey = 'draft:room:' .. roomId .. ':picks_data'
        redis.call('HSET', pickKey, playerId, cjson.encode({
          userId = userId,
          username = username,
          timestamp = timestamp,
          round = round,
          pickNumber = pickNumber
        }))
        
        -- Update room stats
        local statsKey = 'draft:room:' .. roomId .. ':stats'
        redis.call('HINCRBY', statsKey, 'totalPicks', 1)
        redis.call('HSET', statsKey, 'lastPickTime', timestamp)
        redis.call('HSET', statsKey, 'currentRound', round)
        
        return {ok = 'Player picked successfully'}
      `,
      
      getAvailablePlayers: `
        local roomId = KEYS[1]
        local position = ARGV[1]
        
        if position and position ~= '' then
          -- Get available players for specific position from master list
          local masterPosKey = 'draft:master_positions:' .. position
          local pickedKey = 'draft:room:' .. roomId .. ':picked_ids'
          return redis.call('SDIFF', masterPosKey, pickedKey)
        else
          -- Get all available players from master list
          local masterKey = 'draft:master_list'
          local pickedKey = 'draft:room:' .. roomId .. ':picked_ids'
          return redis.call('SDIFF', masterKey, pickedKey)
        end
      `,
      
      getRoomStats: `
        local roomId = KEYS[1]
        local statsKey = 'draft:room:' .. roomId .. ':stats'
        local pickedKey = 'draft:room:' .. roomId .. ':picked_ids'
        
        local stats = redis.call('HGETALL', statsKey)
        local pickedCount = redis.call('SCARD', pickedKey)
        
        return {stats, pickedCount}
      `
    };
  }

  async initialize() {
    try {
      console.log('🔌 Initializing Redis connection...');
      await this.connect();
      if (this.isConnected) {
        console.log('✅ Redis service initialized successfully');
      } else {
        console.log('❌ Redis connection failed - Redis is required for caching');
        throw new Error('Redis connection failed - Redis is required for caching');
      }
    } catch (error) {
      console.error('❌ Redis initialization failed:', error.message);
      throw error;
    }
  }

  async connect() {
    try {
      console.log('🔌 Attempting to connect to Redis...');
      
      this.redis = Redis.createClient({
        url: this.connectionString,
        socket: {
          connectTimeout: 10000, // 10 seconds
          commandTimeout: 5000,  // 5 seconds
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              console.log('❌ Max Redis reconnection attempts reached');
              return false; // Stop trying
            }
            console.log(`🔄 Redis reconnection attempt ${retries}/10`);
            return Math.min(retries * 1000, 5000); // Exponential backoff, max 5s
          }
        }
      });
      
      // Handle connection events
      this.redis.on('connect', () => {
        console.log('🔌 Redis connecting...');
      });
      
      this.redis.on('ready', () => {
        console.log('✅ Redis ready');
        this.isConnected = true;
        this.processWriteQueue(); // Process any queued writes
      });
      
      this.redis.on('error', (err) => {
        console.error('❌ Redis error:', err.message);
        this.isConnected = false;
      });
      
      this.redis.on('end', () => {
        console.log('🔌 Redis connection ended');
        this.isConnected = false;
      });
      
      await this.redis.connect();
      
      // Test the connection
      await this.redis.ping();
      console.log('✅ Redis ping successful');
      
      this.isConnected = true;
      return true;
    } catch (error) {
      console.error('❌ Failed to connect to Redis:', error.message);
      console.error('❌ Connection details:', {
        hasUrl: !!this.connectionString,
        urlLength: this.connectionString ? this.connectionString.length : 0,
        errorType: error.constructor.name
      });
      this.isConnected = false;
      return false;
    }
  }

  async disconnect() {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
      this.isConnected = false;
    }
  }

  // Initialize master player list and position sets
  async initializeMasterData(players = null) {
    try {
      console.log('🏈 Initializing master player data in Redis...');
      
      // Fetch players from database if not provided
      let playerData = players;
      if (!playerData) {
        try {
          console.log('📡 Fetching players from PostgreSQL database...');
          playerData = await this.databaseManager.getAllFantasyPlayers();
          console.log(`✅ Fetched ${playerData.length} players from database`);
        } catch (dbError) {
          console.error('❌ Database fetch failed:', dbError.message);
          throw new Error('Unable to fetch players from database');
        }
      }

      if (!this.isConnected) {
        throw new Error('Redis not connected - cannot cache player data');
      }

      // Clear existing data first
      await this.redis.del('draft:master_list');
      
      // Clear all position sets
      const existingPositionKeys = await this.redis.keys('draft:master_positions:*');
      if (existingPositionKeys.length > 0) {
        await this.redis.del(existingPositionKeys);
      }
      
      // Add all players to master list
      const playerIds = playerData.map(p => String(p.PlayerID));
      if (playerIds.length > 0) {
        await this.redis.sAdd('draft:master_list', playerIds);
      }
      
      // Group players by position and add to position sets
      const positionGroups = {};
      playerData.forEach(player => {
        if (!positionGroups[player.Position]) {
          positionGroups[player.Position] = [];
        }
        positionGroups[player.Position].push(String(player.PlayerID));
      });
      
      for (const [position, ids] of Object.entries(positionGroups)) {
        if (ids.length > 0) {
          await this.redis.sAdd(`draft:master_positions:${position}`, ids);
        }
      }
      
      // Store simplified player data for quick access (only PlayerID and Position)
      const playerDataKey = 'draft:player_data';
      await this.redis.del(playerDataKey);
      
      // Store player data as JSON strings for quick retrieval
      for (const player of playerData) {
        await this.redis.hSet(playerDataKey, player.PlayerID.toString(), JSON.stringify(player));
      }
      
      console.log(`✅ Stored ${playerData.length} simplified player details in Redis`);
      this.lastCacheUpdate = Date.now();
      
      console.log(`✅ Initialized Redis with ${playerData.length} players across ${Object.keys(positionGroups).length} positions`);
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize master data:', error);
      throw error;
    }
  }

  // Create a new draft room
  async createRoom(roomId, config = {}) {
    const roomData = {
      roomId,
      createdAt: new Date().toISOString(),
      currentRound: 1,
      totalPicks: 0,
      lastPickTime: null,
      ...config
    };

    if (!this.isConnected) {
      throw new Error('Redis not connected - cannot create room');
    }

    try {
      // Initialize room stats
      await this.redis.hSet(`draft:room:${roomId}:stats`, {
        roomId: roomId,
        createdAt: roomData.createdAt,
        currentRound: roomData.currentRound,
        totalPicks: roomData.totalPicks,
        lastPickTime: roomData.lastPickTime || ''
      });
      
      console.log(`✅ Created draft room ${roomId} in Redis`);
      return roomData;
    } catch (error) {
      console.error('❌ Failed to create room:', error);
      throw error;
    }
  }

  // Pick a player atomically
  async pickPlayer(roomId, playerId, userId, username, round, pickNumber) {
    const timestamp = new Date().toISOString();
    
    if (!this.isConnected) {
      throw new Error('Redis not connected - cannot pick player');
    }

    try {
      // Check if player is already picked in this room
      const isPicked = await this.redis.sIsMember(`draft:room:${roomId}:picked_ids`, playerId);
      if (isPicked === 1) {
        throw new Error('Player already picked');
      }

      // Check if player exists in master list
      const existsInMaster = await this.redis.sIsMember('draft:master_list', playerId);
      if (existsInMaster === 0) {
        throw new Error('Player not found in master list');
      }

      // Use Redis pipeline for atomic operations
      const pipeline = this.redis.multi();
      
      // Add player to picked set
      pipeline.sAdd(`draft:room:${roomId}:picked_ids`, playerId);
      
      // Store pick metadata
      const pickKey = `draft:room:${roomId}:picks_data`;
      pipeline.hSet(pickKey, playerId, JSON.stringify({
        userId: userId,
        username: username,
        timestamp: timestamp,
        round: round,
        pickNumber: pickNumber
      }));
      
      // Update room stats
      const statsKey = `draft:room:${roomId}:stats`;
      pipeline.hIncrBy(statsKey, 'totalPicks', 1);
      pipeline.hSet(statsKey, 'lastPickTime', timestamp);
      pipeline.hSet(statsKey, 'currentRound', round);
      
      // Execute all operations atomically
      await pipeline.exec();
      
      console.log(`✅ Player ${playerId} picked by ${username} in room ${roomId}`);
      return {
        success: true,
        playerId,
        userId,
        username,
        timestamp,
        round,
        pickNumber
      };
    } catch (error) {
      console.error('❌ Failed to pick player:', error);
      throw error;
    }
  }

  // Get available players (using SDIFF)
  async getAvailablePlayers(roomId, position = null) {
    if (!this.isConnected) {
      throw new Error('Redis not connected - cannot get available players');
    }

    try {
      const result = await this.redis.eval(this.luaScripts.getAvailablePlayers, {
        keys: [roomId],
        arguments: [String(position || '')]
      });
      
      return result;
    } catch (error) {
      console.error('❌ Failed to get available players:', error);
      throw error;
    }
  }

  // Get room statistics
  async getRoomStats(roomId) {
    if (!this.isConnected) {
      throw new Error('Redis not connected - cannot get room stats');
    }

    try {
      // Get stats from Redis hash
      const stats = await this.redis.hGetAll(`draft:room:${roomId}:stats`);
      
      // Get actual picked count from the picked_ids set
      const pickedCount = await this.redis.sCard(`draft:room:${roomId}:picked_ids`);
      
      // Calculate total picks from the actual picked set count
      const totalPicks = pickedCount;
      
      return {
        roomId,
        createdAt: stats.createdAt || '',
        currentRound: stats.currentRound || '1',
        totalPicks: String(totalPicks), // Convert to string to match expected format
        lastPickTime: stats.lastPickTime || '',
        userCount: stats.userCount || '0',
        lastUserUpdate: stats.lastUserUpdate || '',
        pickedCount: pickedCount
      };
    } catch (error) {
      console.error('❌ Failed to get room stats:', error);
      throw error;
    }
  }

  // Get pick history for a room
  async getPickHistory(roomId) {
    if (!this.isConnected) {
      throw new Error('Redis not connected - cannot get pick history');
    }

    try {
      const picksData = await this.redis.hGetAll(`draft:room:${roomId}:picks_data`);
      const history = [];
      
      for (const [playerId, pickData] of Object.entries(picksData)) {
        try {
          const parsed = JSON.parse(pickData);
          history.push({
            playerId,
            ...parsed
          });
        } catch (e) {
          console.error('Failed to parse pick data:', e);
        }
      }
      
      return history.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    } catch (error) {
      console.error('❌ Failed to get pick history:', error);
      throw error;
    }
  }

  // Get picked players for a room (alias for getPickHistory)
  async getPickedPlayers(roomId) {
    return this.getPickHistory(roomId);
  }

  // Check if a player is available
  async isPlayerAvailable(roomId, playerId) {
    if (!this.isConnected) {
      throw new Error('Redis not connected - cannot check player availability');
    }

    try {
      const result = await this.redis.sIsMember(`draft:room:${roomId}:picked_ids`, playerId);
      return result === 0; // 0 means not in picked set (available)
    } catch (error) {
      console.error('❌ Failed to check player availability:', error);
      throw error;
    }
  }

  // Update room round
  async updateRoomRound(roomId, round) {
    if (!this.isConnected) {
      throw new Error('Redis not connected - cannot update room round');
    }

    try {
      await this.redis.hSet(`draft:room:${roomId}:stats`, 'currentRound', round);
    } catch (error) {
      console.error('❌ Failed to update room round:', error);
      throw error;
    }
  }

  // Delete a room (cleanup)
  async deleteRoom(roomId) {
    if (!this.isConnected) {
      throw new Error('Redis not connected - cannot delete room');
    }

    try {
      const pipeline = this.redis.multi();
      pipeline.del(`draft:room:${roomId}:stats`);
      pipeline.del(`draft:room:${roomId}:picked_ids`);
      pipeline.del(`draft:room:${roomId}:picks_data`);
      pipeline.del(`draft:room:${roomId}:users`);
      await pipeline.exec();
      console.log(`✅ Deleted room ${roomId} from Redis (including users)`);
    } catch (error) {
      console.error('❌ Failed to delete room:', error);
      throw error;
    }
  }

  // Process write queue when Redis reconnects
  async processWriteQueue() {
    if (this.writeQueue.length === 0) return;
    
    console.log(`🔄 Processing ${this.writeQueue.length} queued writes...`);
    
    for (const write of this.writeQueue) {
      try {
        await write();
      } catch (error) {
        console.error('❌ Failed to process queued write:', error);
      }
    }
    
    this.writeQueue = [];
    console.log('✅ Write queue processed');
  }

  // Health check
  async healthCheck() {
    if (!this.isConnected) {
      return {
        status: 'unhealthy',
        message: 'Redis disconnected',
        writeQueueSize: this.writeQueue.length
      };
    }

    try {
      await this.redis.ping();
      return {
        status: 'healthy',
        message: 'Redis connected and responsive'
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: 'Redis health check failed',
        error: error.message
      };
    }
  }

  /**
   * Get player details by ID from Redis cache
   */
  async getPlayerDetails(playerId) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis not connected - cannot get player details');
      }

      const playerDataKey = 'draft:player_data';
      const playerJson = await this.redis.hGet(playerDataKey, playerId.toString());
      
      if (playerJson) {
        return JSON.parse(playerJson);
      }
      
      return null;
    } catch (error) {
      console.error('❌ Error getting player details:', error);
      throw error;
    }
  }

  /**
   * Refresh cache from database
   */
  async refreshCache() {
    try {
      console.log('🔄 Refreshing player cache from database...');
      await this.initializeMasterData(); // This will fetch from database
      console.log('✅ Cache refresh completed');
      return true;
    } catch (error) {
      console.error('❌ Cache refresh failed:', error);
      throw error;
    }
  }

  /**
   * Check if cache needs refresh
   */
  shouldRefreshCache() {
    const now = Date.now();
    return (now - this.lastCacheUpdate) > this.cacheUpdateInterval;
  }

  /**
   * Add user to room in Redis
   */
  async addUserToRoom(roomId, user) {
    const userData = {
      id: user.id,
      username: user.username,
      clientId: user.clientId || user.id,
      isHost: user.isHost || false,
      joinedAt: user.joinedAt || new Date().toISOString(),
      isConnected: user.isConnected !== undefined ? user.isConnected : true,
      email: user.email || null,
      contestId: user.contestId || null,
      source: user.source || 'join'
    };

    if (!this.isConnected) {
      throw new Error('Redis not connected - cannot add user to room');
    }

    try {
      const userKey = `draft:room:${roomId}:users`;
      await this.redis.hSet(userKey, user.id, JSON.stringify(userData));
      
      // Also update user count in room stats
      const statsKey = `draft:room:${roomId}:stats`;
      const currentUserCount = await this.redis.hLen(userKey);
      await this.redis.hSet(statsKey, 'userCount', currentUserCount);
      await this.redis.hSet(statsKey, 'lastUserJoin', new Date().toISOString());
      
      console.log(`✅ User ${user.username} added to room ${roomId} in Redis`);
      return userData;
    } catch (error) {
      console.error('❌ Failed to add user to room in Redis:', error);
      throw error;
    }
  }

  /**
   * Remove user from room in Redis
   */
  async removeUserFromRoom(roomId, userId) {
    if (!this.isConnected) {
      throw new Error('Redis not connected - cannot remove user from room');
    }

    try {
      const userKey = `draft:room:${roomId}:users`;
      await this.redis.hDel(userKey, userId);
      
      // Update user count in room stats
      const statsKey = `draft:room:${roomId}:stats`;
      const currentUserCount = await this.redis.hLen(userKey);
      await this.redis.hSet(statsKey, 'userCount', currentUserCount);
      await this.redis.hSet(statsKey, 'lastUserLeave', new Date().toISOString());
      
      console.log(`✅ User ${userId} removed from room ${roomId} in Redis`);
    } catch (error) {
      console.error('❌ Failed to remove user from room in Redis:', error);
      throw error;
    }
  }

  /**
   * Get all users in a room from Redis
   */
  async getRoomUsers(roomId) {
    if (!this.isConnected) {
      throw new Error('Redis not connected - cannot get room users');
    }

    try {
      const userKey = `draft:room:${roomId}:users`;
      const usersData = await this.redis.hGetAll(userKey);
      
      const users = [];
      for (const [userId, userData] of Object.entries(usersData)) {
        try {
          users.push(JSON.parse(userData));
        } catch (e) {
          console.error(`Failed to parse user data for ${userId}:`, e);
        }
      }
      
      return users;
    } catch (error) {
      console.error('❌ Failed to get room users from Redis:', error);
      throw error;
    }
  }

  /**
   * Update user connection status
   */
  async updateUserConnectionStatus(roomId, userId, isConnected) {
    if (!this.isConnected) {
      throw new Error('Redis not connected - cannot update user connection status');
    }

    try {
      const userKey = `draft:room:${roomId}:users`;
      const userData = await this.redis.hGet(userKey, userId);
      
      if (userData) {
        const user = JSON.parse(userData);
        user.isConnected = isConnected;
        user.lastConnectionUpdate = new Date().toISOString();
        await this.redis.hSet(userKey, userId, JSON.stringify(user));
        
        console.log(`✅ Updated connection status for user ${userId} in room ${roomId}: ${isConnected}`);
      }
    } catch (error) {
      console.error('❌ Failed to update user connection status in Redis:', error);
      throw error;
    }
  }

  /**
   * Update room users (bulk update)
   */
  async updateRoomUsers(roomId, users) {
    if (!users || users.length === 0) {
      console.log(`⚠️ No users to update for room ${roomId}`);
      return;
    }

    if (!this.isConnected) {
      throw new Error('Redis not connected - cannot update room users');
    }

    try {
      const userKey = `draft:room:${roomId}:users`;
      
      // Clear existing users first
      await this.redis.del(userKey);
      
      // Add all users
      const pipeline = this.redis.multi();
      users.forEach(user => {
        const userData = {
          id: user.id,
          username: user.username,
          clientId: user.clientId || user.id,
          isHost: user.isHost || false,
          joinedAt: user.joinedAt || new Date().toISOString(),
          isConnected: user.isConnected !== undefined ? user.isConnected : true,
          email: user.email || null,
          contestId: user.contestId || null,
          source: user.source || 'bulk_update'
        };
        pipeline.hSet(userKey, user.id, JSON.stringify(userData));
      });
      
      // Update room stats
      const statsKey = `draft:room:${roomId}:stats`;
      pipeline.hSet(statsKey, 'userCount', users.length);
      pipeline.hSet(statsKey, 'lastUserUpdate', new Date().toISOString());
      
      await pipeline.exec();
      
      console.log(`✅ Bulk updated ${users.length} users for room ${roomId} in Redis`);
    } catch (error) {
      console.error('❌ Failed to bulk update room users in Redis:', error);
      throw error;
    }
  }
}

module.exports = RedisDraftService; 