function isDraftValid(userSelections, playerToDraft, lineupConfig) {
  // Step 1: Determine Open Lineup Slots
  // Count current selections by position and FLEX
  const counts = {
    QB: 0,
    RB: 0,
    WR: 0,
    TE: 0,
    K: 0,
    DST: 0,
    FLEX: 0,
    BENCH: 0
  };
  
  userSelections.forEach(p => {
    if (p.rosterPosition) {
      counts[p.rosterPosition]++;
    } else {
      counts[p.Position]++;
    }
  });

  // Find position config
  const posConfig = lineupConfig.positions.find(p => p.position === playerToDraft.Position);
  const flexConfig = lineupConfig.positions.find(p => p.position === "FLEX");
  const benchConfig = lineupConfig.positions.find(p => p.position === "BENCH");

  // Step 2: Check if player can fit in any available slot
  // PRIORITIZE MAIN POSITION OVER BENCH

  // 1. Main position slot (highest priority)
  if (posConfig && counts[playerToDraft.Position] < posConfig.maxDraftable) {
    return {
      valid: true,
      position: playerToDraft.Position,
      slot: 'Main'
    };
  }

  // 2. FLEX slot (RB/WR/TE only, if FLEX is available)
  if (
    flexConfig &&
    ["RB", "WR", "TE"].includes(playerToDraft.Position) &&
    counts.FLEX < flexConfig.maxDraftable
  ) {
    return {
      valid: true,
      position: "FLEX",
      slot: 'FLEX'
    };
  }

  // 3. Bench slot (lowest priority - only if no other slots available)
  if (benchConfig && counts.BENCH < benchConfig.maxDraftable) {
    return {
      valid: true,
      position: "BENCH",
      slot: 'Bench'
    };
  }

  // No valid slot available
  return {
    valid: false,
    reason: `No open roster spots for ${playerToDraft.Position}`
  };
}

// Helper function to get open lineup slots for auto-pick
function getOpenLineupSlots(userSelections, lineupConfig) {
  const counts = {
    QB: 0,
    RB: 0,
    WR: 0,
    TE: 0,
    K: 0,
    DST: 0,
    FLEX: 0,
    BENCH: 0
  };
  
  userSelections.forEach(p => {
    if (p.rosterPosition) {
      counts[p.rosterPosition]++;
    } else {
      counts[p.Position]++;
    }
  });

  const openSlots = [];
  
  for (const posConfig of lineupConfig.positions) {
    const currentCount = counts[posConfig.position] || 0;
    if (currentCount < posConfig.maxDraftable) {
      openSlots.push(posConfig.position);
    }
  }
  
  return openSlots;
}

// Helper function to check if player can fill any open slot
function canPlayerFillOpenSlot(player, openSlots) {
  // If only BENCH is open, any player can be selected
  if (openSlots.length === 1 && openSlots[0] === 'BENCH') {
    return true;
  }
  
  // Check if player's position is in open slots
  if (openSlots.includes(player.Position)) {
    return true;
  }
  
  // Check if player can fill FLEX slot
  if (openSlots.includes('FLEX') && ['RB', 'WR', 'TE'].includes(player.Position)) {
    return true;
  }
  
  return false;
}

module.exports = {
  isDraftValid,
  getOpenLineupSlots,
  canPlayerFillOpenSlot
}; 