require('dotenv').config();
const { Pool } = require('pg');

/**
 * DATABASE MANAGER - Handles NFL data storage with modular processing
 */
class DatabaseManager {
  constructor() {
    // Test the connection first
    console.log('🔌 Testing database connection...');
    console.log(`🔐 Environment: ${process.env.NODE_ENV || 'development'}`);
    
    // Debug environment variables
    console.log('🔍 Environment variables:');
    console.log(`  DB_HOST: ${process.env.DB_HOST || 'NOT SET'}`);
    console.log(`  DB_PORT: ${process.env.DB_PORT || 'NOT SET'}`);
    console.log(`  DB_NAME: ${process.env.DB_NAME || 'NOT SET'}`);
    console.log(`  DB_USER: ${process.env.DB_USER || 'NOT SET'}`);
    console.log(`  DB_PASSWORD: ${process.env.DB_PASSWORD ? 'SET' : 'NOT SET'}`);

    // Configure SSL based on environment
    const sslConfig = this.getSSLConfig();

    // Use environment variables for database credentials
    this.pool = new Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000, // Increased from 2000ms to 10000ms
      ssl: sslConfig
    });
    
    // Don't test connection immediately - let it be tested when needed
    console.log('📊 Database pool configured - connection will be tested on first use');
    
    // Topic-specific data processors (will be initialized when needed)
    this.processors = {};
    this.initializeProcessors();
  }

  getSSLConfig() {
    const isProduction = process.env.NODE_ENV === 'production';
    
    if (isProduction) {
      console.log('🔒 Using production SSL configuration');
      return {
        rejectUnauthorized: false, // Allow self-signed certificates for production
      };
    } else {
      console.log('🔓 Using development SSL configuration');
      return {
        rejectUnauthorized: false, // Allow self-signed certificates for development
      };
    }
  }

  async testConnection() {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      console.log('✅ Database connection successful');
      return true;
    } catch (error) {
      console.error('❌ Database connection failed:', error.message);
      console.error('🔧 SSL Error details:', error);
      return false;
    }
  }

  initializeProcessors() {
    // Initialize processors when needed - for now we'll create placeholder processors
    // You can add the actual processor imports here when you create them
    this.processors = {
      'nfl-team': this.createPlaceholderProcessor('nfl-team'),
      'nfl-player': this.createPlaceholderProcessor('nfl-player'),
      'nfl-score': this.createPlaceholderProcessor('nfl-score'), 
      'nfl-live-player': this.createPlaceholderProcessor('nfl-live-player'),
      'nfl-weekly-games': this.createPlaceholderProcessor('nfl-weekly-games')
    };
  }

  createPlaceholderProcessor(topic) {
    return {
      process: async (rawData) => {
        console.log(`📝 Processing ${topic} data:`, rawData);
        return rawData; // Return data as-is for now
      },
      insertIntoTable: async (pool, processedData) => {
        console.log(`💾 Storing ${topic} data in database:`, processedData);
        // Placeholder - implement actual table insertion logic
        return true;
      }
    };
  }

  /**
   * Process and store data based on topic
   */
  async processAndStore(topic, rawData) {
    try {
      const processor = this.processors[topic];
      if (!processor) {
        console.warn(`⚠ No processor found for topic: ${topic}`);
        return;
      }

      // Process the data using topic-specific processor
      const processedData = await processor.process(rawData);
      
      // Store in topic-specific table
      await processor.insertIntoTable(this.pool, processedData);
      
      console.log(`✅ Processed and stored ${topic} data`);
      
    } catch (error) {
      console.error(`❌ Error processing ${topic} data:`, error.message);
      throw error;
    }
  }

  /**
   * Get unique contests for today (using exact query provided)
   */
  async getTodayContests() {
    try {
      const query = `
        SELECT DISTINCT c.*
        FROM core_contest c 
        WHERE c.contest_status = 'in_progress' 
          AND DATE(c.start_time AT TIME ZONE 'America/New_York') = CURRENT_DATE;
      `;
      const result = await this.pool.query(query);
      console.log(`✅ Fetched ${result.rows.length} unique contests for today`);
      return result.rows;
    } catch (error) {
      console.error('❌ Error fetching today\'s contests:', error.message);
      throw error;
    }
  }

  /**
   * Get unique players for today's contests (using exact query provided)
   * Returns only PlayerID and Position, sorted by status
   */
  async getTodayPlayers() {
    try {
      const query = `
        SELECT DISTINCT 
          cp.player_id as "PlayerID",
          cp.position as "Position",
          COALESCE(cp.status, 'Unknown') as "Status",
          CASE COALESCE(cp.status, 'Unknown')
            WHEN 'Active' THEN 1
            WHEN 'Inactive' THEN 2
            WHEN 'Physically Unable to Perform' THEN 3
            ELSE 4
          END as "StatusPriority"
        FROM core_nfl_player cp
        JOIN core_nfl_game cg ON (cp.team_id::text = cg.home_team_id::text OR cp.team_id::text = cg.away_team_id::text)
        JOIN core_contest c ON cg.game_id = ANY(c.game_ids)
        WHERE c.contest_status = 'in_progress' 
          AND DATE(c.start_time AT TIME ZONE 'America/New_York') = CURRENT_DATE
          AND cp.position IN ('QB', 'RB', 'WR', 'TE', 'DST', 'K')
        ORDER BY 
          "StatusPriority" ASC,
          cp.player_id ASC;
      `;
      
      const result = await this.pool.query(query);
      console.log(`✅ Fetched ${result.rows.length} unique players for today's contests, sorted by status`);
      
      // Return PlayerID, Position, and Status for auto-pick logic
      const simplifiedPlayers = result.rows.map(player => ({
        PlayerID: player.PlayerID,
        Position: player.Position,
        Status: player.Status // Keep status for smart auto-pick
      }));
      
      console.log(`✅ Simplified to ${simplifiedPlayers.length} players with only PlayerID and Position`);
      return simplifiedPlayers;
    } catch (error) {
      console.error('❌ Error fetching today\'s players:', error.message);
      throw error;
    }
  }

  /**
   * Get all available NFL players for fantasy draft (PlayerID and Position only)
   * Sorted by status (will eventually be ADP - Average Draft Position)
   */
  async getAllFantasyPlayers() {
    try {
      console.log('🏈 Fetching fantasy players from database (PlayerID and Position only)...');
      
      // Test connection first
      const isConnected = await this.testConnection();
      if (!isConnected) {
        throw new Error('Database connection failed');
      }
      
      // Try the main query first
      let query = `
        SELECT DISTINCT
          cp.player_id as "PlayerID",
          cp.position as "Position",
          COALESCE(cp.status, 'Unknown') as "Status",
          CASE COALESCE(cp.status, 'Unknown')
            WHEN 'Active' THEN 1
            WHEN 'Inactive' THEN 2
            WHEN 'Physically Unable to Perform' THEN 3
            ELSE 4
          END as "StatusPriority"
        FROM core_nfl_player cp
        WHERE cp.position IN ('QB', 'RB', 'WR', 'TE', 'DST', 'K')
        ORDER BY 
          "StatusPriority" ASC,
          cp.player_id ASC
        LIMIT 1000;
      `;
      
      try {
        const result = await this.pool.query(query);
        console.log(`✅ Fetched ${result.rows.length} players sorted by status from database`);
        
        if (result.rows.length === 0) {
          console.log('⚠️ No players found with position filter. Trying without filters...');
          
          // Fallback query without filters
          const fallbackQuery = `
            SELECT DISTINCT
              cp.player_id as "PlayerID",
              cp.position as "Position"
            FROM core_nfl_player cp
            ORDER BY cp.player_id ASC
            LIMIT 1000;
          `;
          
          const fallbackResult = await this.pool.query(fallbackQuery);
          console.log(`✅ Fallback query returned ${fallbackResult.rows.length} players`);
          
          // Return simplified players from fallback
          const simplifiedPlayers = fallbackResult.rows.map(player => ({
            PlayerID: player.PlayerID,
            Position: player.Position
          }));
          
          return simplifiedPlayers;
        }
        
        // Return PlayerID, Position, and Status for auto-pick logic
        const simplifiedPlayers = result.rows.map(player => ({
          PlayerID: player.PlayerID,
          Position: player.Position,
          Status: player.Status // Keep status for smart auto-pick
        }));
        
        console.log(`✅ Simplified to ${simplifiedPlayers.length} players with only PlayerID and Position`);
        return simplifiedPlayers;
        
      } catch (queryError) {
        console.error('❌ Main query failed, trying basic query:', queryError.message);
        
        // Basic fallback query
        const basicQuery = `
          SELECT 
            player_id as "PlayerID",
            position as "Position"
          FROM core_nfl_player
          LIMIT 500;
        `;
        
        const basicResult = await this.pool.query(basicQuery);
        console.log(`✅ Basic query returned ${basicResult.rows.length} players`);
        
        return basicResult.rows.map(player => ({
          PlayerID: player.PlayerID,
          Position: player.Position
        }));
      }
      
    } catch (error) {
      console.error('❌ Error fetching fantasy players:', error.message);
      
      // Return empty array instead of throwing to prevent room creation failure
      console.log('⚠️ Returning empty player pool to prevent system failure');
      return [];
    }
  }

  /**
   * Get players by position with full details
   */
  async getPlayersByPosition(position) {
    try {
      const query = `
        SELECT DISTINCT
          cp.player_id as "PlayerID",
          cp.position as "Position",
          cp.status as "Status",
          cp.team_id as "TeamID",
          cp.metadata->>'first_name' as "FirstName",
          cp.metadata->>'last_name' as "LastName",
          CONCAT(cp.metadata->>'first_name', ' ', cp.metadata->>'last_name') as "Name",
          cp.metadata->>'jersey_number' as "JerseyNumber",
          cp.metadata->>'height' as "Height",
          cp.metadata->>'weight' as "Weight",
          cp.metadata->>'college' as "College",
          cp.metadata->>'experience' as "Experience",
          cp.metadata->>'birth_date' as "BirthDate",
          cp.current_points as "FantasyPoints",
          cp.projected_points as "FantasyPointsPPR",
          ct.name as "Team",
          ct.metadata->>'abbreviation' as "TeamAbbr"
        FROM core_nfl_player cp
        LEFT JOIN core_nfl_team ct ON cp.team_id = ct.team_id
        WHERE cp.position = $1
          AND cp.active = true
        ORDER BY cp.status ASC;
      `;
      
      const result = await this.pool.query(query, [position]);
      console.log(`✅ Fetched ${result.rows.length} ${position} players from database with full details`);
      
      return result.rows;
    } catch (error) {
      console.error(`❌ Error fetching ${position} players:`, error.message);
      throw error;
    }
  }

  /**
   * Get users for a specific contest from core_user_contest table
   * Returns users directly from core_user_contest without complex JOINs
   */
  async getContestUsers(contestId) {
    try {
      console.log(`👥 Fetching users for contest ${contestId} from core_user_contest table...`);
      
      // Simple query to get users directly from core_user_contest
      const query = `
        SELECT DISTINCT 
          cuc.user_id,
          cuc.contest_id,
          cuc.joined_at
        FROM core_user_contest cuc
        WHERE cuc.contest_id = $1
        ORDER BY cuc.joined_at ASC;
      `;
      
      const result = await this.pool.query(query, [contestId]);
      console.log(`✅ Fetched ${result.rows.length} users for contest ${contestId} from core_user_contest`);
      
      if (result.rows.length > 0) {
        // Log user details for debugging 
        result.rows.forEach((user, index) => {
          console.log(`   User ${index + 1}: ${user.user_id} - Contest: ${user.contest_id} - Joined: ${user.joined_at}`);
        });
        
        // Transform to expected format for room creation
        const transformedUsers = result.rows.map((user, index) => ({
          user_id: user.user_id,
          contest_id: user.contest_id,
          username: user.user_id, // Use user_id as username since that's what we have
          email: `${user.user_id}@example.com`, // Generate email since we don't have it
          first_name: user.user_id.replace('user', 'User '), // Generate name from user_id
          last_name: '',
          auth_user_id: user.user_id,
          joined_at: user.joined_at
        }));
        
        console.log(`✅ Transformed ${transformedUsers.length} users for room assignment`);
        return transformedUsers;
      }
      
      console.log(`⚠️ No users found for contest ${contestId}`);
      return [];
      
    } catch (error) {
      console.error('❌ Error fetching contest users:', error.message);
      
      // Fallback: Return empty array to prevent system crash
      console.log('⚠️ Returning empty user array to prevent system failure');
      return [];
    }
  }

  /**
   * Get all contests with their users for room creation
   */
  async getAllContestsWithUsers() {
    try {
      console.log('🏈 Fetching all contests with users from database...');
      
      const query = `
        SELECT DISTINCT 
          c.id as contest_id,
          c.contest_status,
          c.start_time,
          c.game_ids,
          c.created_at,
          COUNT(cuc.user_id) as user_count
        FROM core_contest c
        LEFT JOIN core_user_contest cuc ON c.id = cuc.contest_id
        WHERE c.contest_status IN ('in_progress', 'pending')
        GROUP BY c.id, c.contest_status, c.start_time, c.game_ids, c.created_at
        HAVING COUNT(cuc.user_id) > 0
        ORDER BY c.start_time ASC;
      `;
      
      const result = await this.pool.query(query);
      console.log(`✅ Fetched ${result.rows.length} contests with users from database`);
      
      // For each contest, get the users
      const contestsWithUsers = await Promise.all(
        result.rows.map(async (contest) => {
          const users = await this.getContestUsers(contest.contest_id);
          return {
            ...contest,
            users: users
          };
        })
      );
      
      return contestsWithUsers;
    } catch (error) {
      console.error('❌ Error fetching contests with users:', error.message);
      throw error;
    }
  }

  /**
   * Get active contests that need rooms created (specifically in_progress with 2+ users)
   */
  async getActiveContestsForRooms() {
    try {
      console.log('🔍 Fetching in_progress contests with players_required >= 2 and players_joined >= 2 for room creation...');
      
      // First, let's check what contest statuses exist
      const statusQuery = `
        SELECT DISTINCT contest_status, COUNT(*) as count 
        FROM core_contest 
        GROUP BY contest_status 
        ORDER BY count DESC;
      `;
      
      try {
        const statusResult = await this.pool.query(statusQuery);
        console.log('📊 Available contest statuses in database:');
        statusResult.rows.forEach(row => {
          console.log(`   - "${row.contest_status}": ${row.count} contests`);
        });
      } catch (statusError) {
        console.log('⚠️ Could not check contest statuses:', statusError.message);
      }
      
      // Query specifically for in_progress contests with players_required >= 2 and players_joined >= 2
      const contestQuery = `
        SELECT DISTINCT 
          c.id,
          c.contest_status,
          c.start_time,
          c.game_ids,
          c.created_at,
          c.players_required,
          c.players_joined,
          COUNT(cuc.user_id) as user_count_from_table
        FROM core_contest c
        LEFT JOIN core_user_contest cuc ON c.id = cuc.contest_id
        WHERE c.contest_status = 'in_progress'
          AND c.players_required >= 2
          AND c.players_joined >= 2
        GROUP BY c.id, c.contest_status, c.start_time, c.game_ids, c.created_at, c.players_required, c.players_joined
        ORDER BY c.start_time DESC;
      `;
      
      const result = await this.pool.query(contestQuery);
      console.log(`✅ Found ${result.rows.length} in_progress contests with players_required >= 2 and players_joined >= 2`);
      
      // Convert the results to the expected format
      const contestsWithUsers = result.rows.map(contest => ({
        contest_id: contest.id,
        contest_status: contest.contest_status,
        start_time: contest.start_time,
        game_ids: contest.game_ids,
        created_at: contest.created_at,
        players_required: parseInt(contest.players_required),
        players_joined: parseInt(contest.players_joined),
        user_count: parseInt(contest.players_joined) // Use players_joined as the main user count
      }));
      
      // Log contest details
      contestsWithUsers.forEach((contest, index) => {
        console.log(`   Contest ${index + 1}: ID ${contest.contest_id} - Requires ${contest.players_required} players, joined ${contest.players_joined} players (${contest.contest_status})`);
      });
      
      return contestsWithUsers;
      
    } catch (error) {
      console.error('❌ Error fetching in_progress contests with players_required >= 2:', error.message);
      
      // Fallback: try to find any contests with users
      console.log('🔄 Trying fallback query to find any contests with users...');
      
      try {
        const fallbackQuery = `
          SELECT DISTINCT 
            c.id,
            c.contest_status,
            c.start_time,
            c.game_ids,
            c.created_at,
            c.players_required,
            c.players_joined
          FROM core_contest c
          WHERE c.players_required >= 2
            AND c.players_joined >= 2
          ORDER BY c.start_time DESC
          LIMIT 20;
        `;
        
        const fallbackResult = await this.pool.query(fallbackQuery);
        console.log(`✅ Fallback found ${fallbackResult.rows.length} contests with players_required >= 2 and players_joined >= 2 (any status)`);
        
        const fallbackContests = fallbackResult.rows.map(contest => ({
          contest_id: contest.id,
          contest_status: contest.contest_status,
          start_time: contest.start_time,
          game_ids: contest.game_ids,
          created_at: contest.created_at,
          players_required: parseInt(contest.players_required),
          players_joined: parseInt(contest.players_joined),
          user_count: parseInt(contest.players_joined)
        }));
        
        // Log fallback contest details
        fallbackContests.forEach((contest, index) => {
          console.log(`   Fallback Contest ${index + 1}: ID ${contest.contest_id} - Requires ${contest.players_required} players, joined ${contest.players_joined} players (${contest.contest_status})`);
        });
        
        return fallbackContests;
        
      } catch (fallbackError) {
        console.error('❌ Fallback query also failed:', fallbackError.message);
        throw error;
      }
    }
  }

  /**
   * Check if a user is authorized for a specific contest
   */
  async isUserAuthorizedForContest(username, contestId) {
    try {
      console.log(`🔐 Checking authorization for user ${username} in contest ${contestId}...`);
      
      // Try primary JOIN condition (user_id = username)
      let query = `
        SELECT COUNT(*) as count
        FROM core_user_contest cuc
        JOIN auth_user au ON cuc.user_id = au.username
        WHERE au.username = $1 
          AND cuc.contest_id = $2;
      `;
      
      try {
        const result = await this.pool.query(query, [username, contestId]);
        const isAuthorized = parseInt(result.rows[0].count) > 0;
        
        if (isAuthorized) {
          console.log(`✅ User ${username} authorization for contest ${contestId}: AUTHORIZED (JOIN on username)`);
          return true;
        }
      } catch (primaryError) {
        console.log(`⚠️ Primary authorization check failed: ${primaryError.message}. Trying fallback...`);
      }
      
      // Fallback JOIN condition (user_id = id with casting)
      const fallbackQuery = `
        SELECT COUNT(*) as count
        FROM core_user_contest cuc
        JOIN auth_user au ON cuc.user_id::integer = au.id
        WHERE au.username = $1 
          AND cuc.contest_id = $2;
      `;
      
      const fallbackResult = await this.pool.query(fallbackQuery, [username, contestId]);
      const isAuthorized = parseInt(fallbackResult.rows[0].count) > 0;
      
      console.log(`✅ User ${username} authorization for contest ${contestId}: ${isAuthorized ? 'AUTHORIZED' : 'NOT AUTHORIZED'} (JOIN on username)`);
      
      return isAuthorized;
    } catch (error) {
      console.error('❌ Error checking user authorization:', error.message);
      return false;
    }
  }

  /**
   * Get user details for a specific contest
   */
  async getUserContestDetails(username, contestId) {
    try {
      console.log(`👤 Getting contest details for user ${username} in contest ${contestId}...`);
      
      // Try primary JOIN condition (user_id = id)
      let query = `
        SELECT 
          cuc.user_id,
          cuc.contest_id,
          au.username,
          au.email,
          au.first_name,
          au.last_name,
          au.id as auth_user_id,
          c.contest_status,
          c.start_time
        FROM core_user_contest cuc
        JOIN auth_user au ON cuc.user_id = au.id
        JOIN core_contest c ON cuc.contest_id = c.id
        WHERE au.username = $1 
          AND cuc.contest_id = $2;
      `;
      
      try {
        const result = await this.pool.query(query, [username, contestId]);
        
        if (result.rows.length > 0) {
          console.log(`✅ Found contest details for user ${username} in contest ${contestId} (JOIN on id)`);
          return result.rows[0];
        }
      } catch (primaryError) {
        console.log(`⚠️ Primary contest details query failed: ${primaryError.message}. Trying fallback...`);
      }
      
      // Fallback JOIN condition (user_id = username)
      const fallbackQuery = `
        SELECT 
          cuc.user_id,
          cuc.contest_id,
          au.username,
          au.email,
          au.first_name,
          au.last_name,
          au.id as auth_user_id,
          c.contest_status,
          c.start_time
        FROM core_user_contest cuc
        JOIN auth_user au ON cuc.user_id = au.username
        JOIN core_contest c ON cuc.contest_id = c.id
        WHERE au.username = $1 
          AND cuc.contest_id = $2;
      `;
      
      const fallbackResult = await this.pool.query(fallbackQuery, [username, contestId]);
      
      if (fallbackResult.rows.length === 0) {
        console.log(`❌ No contest details found for user ${username} in contest ${contestId}`);
        return null;
      }
      
      console.log(`✅ Found contest details for user ${username} in contest ${contestId} (JOIN on username)`);
      return fallbackResult.rows[0];
    } catch (error) {
      console.error('❌ Error getting user contest details:', error.message);
      return null;
    }
  }

  /**
   * Get pool instance for direct queries
   */
  getPool() {
    return this.pool;
  }

  async close() {
    await this.pool.end();
  }
}

// Create and export a singleton instance
const databaseManager = new DatabaseManager();

// Also export the class for testing purposes
module.exports = {
  DatabaseManager,
  databaseManager,
  pool: databaseManager.pool // For backward compatibility
};