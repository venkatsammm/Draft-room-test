/**
 * Correct Snake Draft Implementation
 * 
 * This file demonstrates the proper snake draft logic for a fantasy sports draft.
 * 
 * Snake Draft Rules:
 * - Round 1: User 1, 2, 3, 4
 * - Round 2: User 4, 3, 2, 1  
 * - Round 3: User 1, 2, 3, 4
 * - Round 4: User 4, 3, 2, 1
 * - And so on...
 */

class SnakeDraft {
  constructor(numUsers, numRounds) {
    this.numUsers = numUsers;
    this.numRounds = numRounds;
    this.currentRound = 1;
    this.currentTurnIndex = 0;
    this.selections = {}; // Track selections per user
    this.draftComplete = false;
    
    // Initialize user IDs (1-based for clarity)
    this.users = Array.from({length: numUsers}, (_, i) => `User ${i + 1}`);
    
    // Initialize selections tracking
    this.users.forEach(user => {
      this.selections[user] = [];
    });
  }

  /**
   * Get the current turn order for the current round
   * @returns {Array} Array of user IDs in current turn order
   */
  getCurrentTurnOrder() {
    if (this.currentRound % 2 === 1) {
      // Odd rounds: normal order (1, 2, 3, 4)
      return [...this.users];
    } else {
      // Even rounds: reversed order (4, 3, 2, 1)
      return [...this.users].reverse();
    }
  }

  /**
   * Get the current user whose turn it is
   * @returns {string} Current user ID
   */
  getCurrentUser() {
    const currentTurnOrder = this.getCurrentTurnOrder();
    return currentTurnOrder[this.currentTurnIndex];
  }

  /**
   * Get the next user in the turn order
   * @returns {string} Next user ID
   */
  getNextUser() {
    const currentTurnOrder = this.getCurrentTurnOrder();
    const nextIndex = (this.currentTurnIndex + 1) % this.numUsers;
    return currentTurnOrder[nextIndex];
  }

  /**
   * Advance to the next turn
   */
  advanceTurn() {
    this.currentTurnIndex++;
    
    // Check if round is complete
    if (this.currentTurnIndex >= this.numUsers) {
      this.currentRound++;
      this.currentTurnIndex = 0; // Reset to first position in new round
      
      // Check if draft is complete
      if (this.currentRound > this.numRounds) {
        this.draftComplete = true;
      }
    }
  }

  /**
   * Make a selection for the current user
   * @param {string} item - The item being selected
   */
  makeSelection(item) {
    if (this.draftComplete) {
      throw new Error('Draft is already complete');
    }
    
    const currentUser = this.getCurrentUser();
    this.selections[currentUser].push(item);
    
    console.log(`Round ${this.currentRound}, Turn ${this.currentTurnIndex + 1}: ${currentUser} selected ${item}`);
    
    // Advance to next turn
    this.advanceTurn();
  }

  /**
   * Get the current draft state
   * @returns {Object} Current draft state
   */
  getDraftState() {
    return {
      currentRound: this.currentRound,
      currentTurnIndex: this.currentTurnIndex,
      currentUser: this.getCurrentUser(),
      turnOrder: this.getCurrentTurnOrder(),
      selections: this.selections,
      draftComplete: this.draftComplete,
      totalPicks: this.currentRound * this.numUsers - (this.numUsers - this.currentTurnIndex)
    };
  }

  /**
   * Display the complete draft order
   */
  displayDraftOrder() {
    console.log(`\n=== SNAKE DRAFT ORDER (${this.numUsers} users, ${this.numRounds} rounds) ===`);
    
    for (let round = 1; round <= this.numRounds; round++) {
      const turnOrder = round % 2 === 1 ? [...this.users] : [...this.users].reverse();
      console.log(`Round ${round}: ${turnOrder.join(' → ')}`);
    }
  }

  /**
   * Simulate a complete draft
   * @param {Array} items - Array of items to draft
   */
  simulateDraft(items) {
    console.log(`\n=== SIMULATING DRAFT ===`);
    console.log(`Users: ${this.users.join(', ')}`);
    console.log(`Rounds: ${this.numRounds}`);
    console.log(`Total picks: ${this.numUsers * this.numRounds}`);
    
    this.displayDraftOrder();
    
    let itemIndex = 0;
    while (!this.draftComplete && itemIndex < items.length) {
      const item = items[itemIndex];
      this.makeSelection(item);
      itemIndex++;
    }
    
    console.log(`\n=== DRAFT COMPLETE ===`);
    console.log('Final selections:');
    Object.entries(this.selections).forEach(([user, userSelections]) => {
      console.log(`${user}: ${userSelections.join(', ')}`);
    });
  }
}

// Example usage and testing
function testSnakeDraft() {
  console.log('=== SNAKE DRAFT TEST ===');
  
  // Test with 4 users, 3 rounds
  const draft = new SnakeDraft(4, 3);
  
  // Create sample items to draft
  const items = [
    'Player A', 'Player B', 'Player C', 'Player D',
    'Player E', 'Player F', 'Player G', 'Player H',
    'Player I', 'Player J', 'Player K', 'Player L'
  ];
  
  draft.simulateDraft(items);
}

// Run the test
testSnakeDraft();

module.exports = SnakeDraft; 