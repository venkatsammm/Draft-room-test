class PlayerService {
  constructor(redisDraftService) {
    this.redisDraftService = redisDraftService;
    console.log(`📊 PlayerService initialized - using database and Redis for player data`);
  }

  // Get player details by ID from Redis
  async getPlayerById(playerId) {
    if (!playerId) return null;
    try {
      const playerDetails = await this.redisDraftService.getPlayerDetails(playerId);
      return playerDetails;
    } catch (error) {
      console.error('❌ Failed to get player details from Redis:', error);
      return null;
    }
  }

  // Get multiple players by IDs
  async getPlayersByIds(playerIds) {
    const playerPromises = playerIds.map(id => this.getPlayerById(id));
    const players = await Promise.all(playerPromises);
    return players.filter(player => player !== null);
  }

  // Get available players with full details for a room
  async getAvailablePlayersWithDetails(roomId, position = null) {
    try {
      // Get available player IDs from Redis
      const availablePlayerIds = await this.redisDraftService.getAvailablePlayers(roomId, position);
      
      // Get full player details
      const availablePlayers = await this.getPlayersByIds(availablePlayerIds);
      
      return availablePlayers;
    } catch (error) {
      console.error('❌ Failed to get available players with details:', error);
      return [];
    }
  }
  // Get available players by position
  async getAvailablePlayersByPosition(roomId, position) {
    return this.getAvailablePlayersWithDetails(roomId, position);
  }

  // Get all available players
  async getAllAvailablePlayers(roomId) {
    return this.getAvailablePlayersWithDetails(roomId);
  }

  // Get player pool for a room (all available players)
  async getPlayerPool(roomId) {
    return this.getAllAvailablePlayers(roomId);
  }

  // Get picked players with details for a room
  async getPickedPlayersWithDetails(roomId) {
    try {
      const pickHistory = await this.redisDraftService.getPickHistory(roomId);
      
      const pickedPlayers = await Promise.all(
        pickHistory.map(async pick => {
          const player = await this.getPlayerById(pick.playerId);
          return {
            ...pick,
            player: player || { PlayerID: pick.playerId, Name: 'Unknown Player' }
          };
        })
      );
      
      return pickedPlayers;
    } catch (error) {
      console.error('❌ Failed to get picked players with details:', error);
      return [];
    }
  }

  // Get players by position from database
  async getPlayersByPosition(position) {
    try {
      const { databaseManager } = require('./databaseManager');
      const players = await databaseManager.getPlayersByPosition(position);
      return players;
    } catch (error) {
      console.error('❌ Failed to get players by position from database:', error);
      return [];
    }
  }

  // Get all positions available from database
  async getAvailablePositions() {
    try {
      const { databaseManager } = require('./databaseManager');
      const players = await databaseManager.getAllFantasyPlayers();
      const positions = new Set();
      players.forEach(player => {
        if (player.Position) {
          positions.add(player.Position);
        }
      });
      return Array.from(positions);
    } catch (error) {
      console.error('❌ Failed to get available positions from database:', error);
      return [];
    }
  }

  // Search players by name from database
  async searchPlayersByName(searchTerm, limit = 20) {
    try {
      const { databaseManager } = require('./databaseManager');
      const players = await databaseManager.getAllFantasyPlayers();
      const term = searchTerm.toLowerCase();
      const results = players.filter(player => 
        player.Name && player.Name.toLowerCase().includes(term)
      ).slice(0, limit);
      return results;
    } catch (error) {
      console.error('❌ Failed to search players by name:', error);
      return [];
    }
  }

  // Get top players by position from database
  async getTopPlayersByPosition(position, limit = 10) {
    try {
      const players = await this.getPlayersByPosition(position);
      return players.slice(0, limit);
    } catch (error) {
      console.error('❌ Failed to get top players by position:', error);
      return [];
    }
  }

  // Get player statistics from database
  async getPlayerStats() {
    try {
      const { databaseManager } = require('./databaseManager');
      const players = await databaseManager.getAllFantasyPlayers();
      
      const stats = {
        totalPlayers: players.length,
        byPosition: {},
        byTeam: {}
      };
      
      players.forEach(player => {
        // Count by position
        if (player.Position) {
          stats.byPosition[player.Position] = (stats.byPosition[player.Position] || 0) + 1;
        }
        
        // Count by team
        if (player.Team) {
          stats.byTeam[player.Team] = (stats.byTeam[player.Team] || 0) + 1;
        }
      });
      
      return stats;
    } catch (error) {
      console.error('❌ Failed to get player stats from database:', error);
      return { totalPlayers: 0, byPosition: {}, byTeam: {} };
    }
  }

  // Validate player exists in database
  async validatePlayer(playerId) {
    try {
      const player = await this.getPlayerById(playerId);
      return player !== null;
    } catch (error) {
      console.error('❌ Failed to validate player:', error);
      return false;
    }
  }

  // Get player suggestions for auto-pick
  async getAutoPickSuggestions(roomId, userId, userSelections = []) {
    try {
      // Get user's current roster
      const userRoster = await Promise.all(
        userSelections.map(async selection => {
          const player = await this.getPlayerById(selection.playerID);
          return {
            ...selection,
            player: player
          };
        })
      );
      
      // Calculate position needs
      const positionCounts = this.calculatePositionCounts(userRoster);
      const openPositions = this.getOpenPositions(positionCounts);
      
      // Get available players for open positions
      const suggestions = [];
      
      for (const position of openPositions) {
        const availablePlayers = await this.getAvailablePlayersByPosition(roomId, position);
        if (availablePlayers.length > 0) {
          suggestions.push({
            position,
            players: availablePlayers.slice(0, 5) // Top 5 suggestions per position
          });
        }
      }
      
      return suggestions;
    } catch (error) {
      console.error('❌ Failed to get auto-pick suggestions:', error);
      return [];
    }
  }

  // Calculate position counts for a user's roster
  calculatePositionCounts(userSelections) {
    const positionCounts = {
      QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0
    };
    
    userSelections.forEach(selection => {
      const position = selection.player?.Position || selection.rosterPosition;
      if (positionCounts.hasOwnProperty(position)) {
        positionCounts[position]++;
      }
    });
    
    return positionCounts;
  }

  // Get open positions based on lineup requirements
  getOpenPositions(positionCounts) {
    const openPositions = [];
    
    // Basic lineup requirements (can be customized)
    const requirements = {
      QB: { min: 1, max: 3 },
      RB: { min: 2, max: 6 },
      WR: { min: 2, max: 6 },
      TE: { min: 1, max: 3 },
      K: { min: 1, max: 2 },
      DST: { min: 1, max: 2 }
    };
    
    Object.entries(requirements).forEach(([position, req]) => {
      const current = positionCounts[position] || 0;
      if (current < req.max) {
        openPositions.push(position);
      }
    });
    
    return openPositions;
  }

  // Get room draft summary
  async getRoomDraftSummary(roomId) {
    try {
      const [roomStats, pickHistory, availablePlayers] = await Promise.all([
        this.redisDraftService.getRoomStats(roomId),
        this.redisDraftService.getPickHistory(roomId),
        this.getAllAvailablePlayers(roomId)
      ]);
      
      const pickedPlayers = await this.getPlayersByIds(pickHistory.map(p => p.playerId));
      
      // Group picks by user
      const picksByUser = {};
      for (const pick of pickHistory) {
        if (!picksByUser[pick.username]) {
          picksByUser[pick.username] = [];
        }
        const player = await this.getPlayerById(pick.playerId);
        picksByUser[pick.username].push({
          ...pick,
          player: player
        });
      }
      
      // Calculate position distribution
      const positionDistribution = {};
      pickedPlayers.forEach(player => {
        const pos = player.Position;
        positionDistribution[pos] = (positionDistribution[pos] || 0) + 1;
      });
      
      // Get recent picks with player details
      const recentPicks = await Promise.all(
        pickHistory.slice(-10).map(async pick => ({
          ...pick,
          player: await this.getPlayerById(pick.playerId)
        }))
      );
      
      return {
        roomStats,
        totalPicked: pickedPlayers.length,
        totalAvailable: availablePlayers.length,
        picksByUser,
        positionDistribution,
        recentPicks
      };
    } catch (error) {
      console.error('❌ Failed to get room draft summary:', error);
      return null;
    }
  }
}

module.exports = PlayerService; 