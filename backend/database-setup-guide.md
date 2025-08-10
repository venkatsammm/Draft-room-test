# Database Setup Guide for Today's Players Query

## Current Query Implementation
The system uses this exact query to get today's players:

```sql
SELECT DISTINCT 
  cp.player_id as "PlayerID",
  cp.position as "Position"
FROM core_nfl_player cp
JOIN core_nfl_game cg ON (cp.team_id::text = cg.home_team_id::text OR cp.team_id::text = cg.away_team_id::text)
JOIN core_contest c ON cg.game_id = ANY(c.game_ids)
WHERE c.contest_status = 'in_progress' 
  AND DATE(c.start_time AT TIME ZONE 'America/New_York') = CURRENT_DATE
  AND cp.position IN ('QB', 'RB', 'WR', 'TE', 'DST', 'K');
```

## Database Requirements

### 1. Tables That Must Exist
- ✅ `core_nfl_player` - NFL player data
- ✅ `core_nfl_game` - Game information
- ✅ `core_contest` - Contest data
- ✅ `core_user_contest` - User-contest relationships

### 2. Required Columns

#### `core_nfl_player`
```sql
- player_id (integer/varchar) - Player identifier
- position (varchar) - Player position (QB, RB, WR, TE, DST, K)
- team_id (integer/varchar) - Team identifier
- status (varchar) - Player status (Active, Inactive, etc.)
```

#### `core_nfl_game`
```sql
- game_id (integer) - Game identifier
- home_team_id (integer/varchar) - Home team ID
- away_team_id (integer/varchar) - Away team ID
```

#### `core_contest`
```sql
- id (integer) - Contest identifier
- contest_status (varchar) - Status: 'in_progress', 'pending', 'open'
- start_time (timestamp) - Contest start time
- game_ids (integer[]) - Array of game IDs
```

#### `core_user_contest`
```sql
- user_id (varchar) - User identifier (casts to integer)
- contest_id (integer) - Contest identifier
```

## Database Changes You Need to Make

### 1. Ensure Contests Have Today's Date
```sql
-- Check current contests
SELECT id, contest_status, start_time 
FROM core_contest 
WHERE DATE(start_time AT TIME ZONE 'America/New_York') = CURRENT_DATE;

-- Update contests to today if needed
UPDATE core_contest 
SET start_time = CURRENT_DATE + INTERVAL '20 hours'  -- 8 PM today
WHERE contest_status = 'in_progress';
```

### 2. Ensure Games Exist and Are Linked
```sql
-- Check if games exist
SELECT COUNT(*) FROM core_nfl_game;

-- Insert sample games if none exist
INSERT INTO core_nfl_game (game_id, home_team_id, away_team_id) VALUES
(1, 1, 2),
(2, 3, 4),
(3, 5, 6);

-- Update contests to include game IDs
UPDATE core_contest 
SET game_ids = ARRAY[1, 2, 3]
WHERE game_ids IS NULL OR array_length(game_ids, 1) IS NULL;
```

### 3. Ensure Players Have Teams
```sql
-- Check player-team relationships
SELECT COUNT(*) FROM core_nfl_player WHERE team_id IS NOT NULL;

-- Update players with team IDs if missing
UPDATE core_nfl_player 
SET team_id = (player_id % 32) + 1  -- Distribute players across 32 teams
WHERE team_id IS NULL;
```

### 4. Ensure Proper Positions
```sql
-- Check player positions
SELECT position, COUNT(*) 
FROM core_nfl_player 
GROUP BY position;

-- Update positions if needed
UPDATE core_nfl_player 
SET position = CASE 
  WHEN position IS NULL OR position = '' THEN 'RB'
  WHEN position NOT IN ('QB', 'RB', 'WR', 'TE', 'DST', 'K') THEN 'RB'
  ELSE position
END;
```

## Quick Setup Script

### Option 1: Update Existing Data
```sql
-- Make contests active for today
UPDATE core_contest 
SET contest_status = 'in_progress',
    start_time = CURRENT_DATE + INTERVAL '20 hours'
WHERE id IN (1, 52, 53, 54, 55, 56);

-- Ensure game IDs are set
UPDATE core_contest 
SET game_ids = ARRAY[1, 2, 3]
WHERE game_ids IS NULL;

-- Ensure games exist
INSERT INTO core_nfl_game (game_id, home_team_id, away_team_id) 
VALUES (1, 1, 2), (2, 3, 4), (3, 5, 6)
ON CONFLICT (game_id) DO NOTHING;
```

### Option 2: Create Sample Data
```sql
-- Insert sample games
INSERT INTO core_nfl_game (game_id, home_team_id, away_team_id) VALUES
(101, 1, 2),
(102, 3, 4),
(103, 5, 6),
(104, 7, 8);

-- Insert sample contest for today
INSERT INTO core_contest (id, contest_status, start_time, game_ids) VALUES
(999, 'in_progress', CURRENT_DATE + INTERVAL '20 hours', ARRAY[101, 102, 103, 104]);

-- Link users to the new contest
INSERT INTO core_user_contest (user_id, contest_id) 
SELECT DISTINCT user_id, 999 
FROM core_user_contest 
LIMIT 4;
```

## Verification Queries

### 1. Check Today's Contests
```sql
SELECT id, contest_status, start_time, game_ids
FROM core_contest 
WHERE DATE(start_time AT TIME ZONE 'America/New_York') = CURRENT_DATE
  AND contest_status = 'in_progress';
```

### 2. Check Player Count for Today
```sql
SELECT COUNT(*) as player_count
FROM core_nfl_player cp
JOIN core_nfl_game cg ON (cp.team_id::text = cg.home_team_id::text OR cp.team_id::text = cg.away_team_id::text)
JOIN core_contest c ON cg.game_id = ANY(c.game_ids)
WHERE c.contest_status = 'in_progress' 
  AND DATE(c.start_time AT TIME ZONE 'America/New_York') = CURRENT_DATE
  AND cp.position IN ('QB', 'RB', 'WR', 'TE', 'DST', 'K');
```

### 3. Check Users for Today's Contests
```sql
SELECT c.id, COUNT(cuc.user_id) as user_count
FROM core_contest c
LEFT JOIN core_user_contest cuc ON c.id = cuc.contest_id
WHERE DATE(c.start_time AT TIME ZONE 'America/New_York') = CURRENT_DATE
  AND c.contest_status = 'in_progress'
GROUP BY c.id;
```

## Common Issues & Fixes

### Issue 1: No Players Found
**Cause**: Game IDs don't match between contests and games
**Fix**: Update game_ids in contests or create matching games

### Issue 2: No Contests for Today
**Cause**: Contest start_time is not today
**Fix**: Update start_time to today's date

### Issue 3: Team ID Mismatch
**Cause**: Player team_id doesn't match game team IDs
**Fix**: Ensure consistent team ID format (integer vs varchar)

### Issue 4: Wrong Positions
**Cause**: Player positions not in allowed list
**Fix**: Update positions to QB, RB, WR, TE, DST, K

## Recommended Approach

1. **First**: Run verification queries to see current state
2. **Then**: Update existing contests to today's date
3. **Next**: Ensure game_ids are properly set
4. **Finally**: Verify the complete query returns players

This will make your "today's players" query work correctly!
