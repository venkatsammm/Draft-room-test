import React, { useEffect, useState, useRef } from "react";
import * as Ably from "ably";
import axios from "axios";
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
// import DraftSimulator from "./DraftSimulator"

const App = () => {
  // Connection state
  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState("");
  const [inRoom, setInRoom] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [clientId, setClientId] = useState("");
  const [ably, setAbly] = useState(null);
  const [channel, setChannel] = useState(null);
  const [ablyConnectionStatus, setAblyConnectionStatus] = useState("disconnected");
  const [ablyConnectionDetails, setAblyConnectionDetails] = useState({});

  // Game state
  const [users, setUsers] = useState([]);
  const [disconnectedUsers, setDisconnectedUsers] = useState([]);
  const [pool, setPool] = useState([]);
  const [selections, setSelections] = useState({});
  const [gameStarted, setGameStarted] = useState(false);
  const [currentPhase, setCurrentPhase] = useState("main");

  // Chunked data state for Ably messages
  const [poolChunks, setPoolChunks] = useState([]);
  const [poolTotalChunks, setPoolTotalChunks] = useState(0);
  const [selectionsChunks, setSelectionsChunks] = useState([]);
  const [selectionsTotalChunks, setSelectionsTotalChunks] = useState(0);
  const [playerSelectedPoolChunks, setPlayerSelectedPoolChunks] = useState([]);
  const [playerSelectedPoolTotalChunks, setPlayerSelectedPoolTotalChunks] = useState(0);
  const [playerSelectedSelectionsChunks, setPlayerSelectedSelectionsChunks] = useState([]);
  const [playerSelectedSelectionsTotalChunks, setPlayerSelectedSelectionsTotalChunks] = useState(0);
  const [playerSelectedMeta, setPlayerSelectedMeta] = useState(null);
  const [draftStartedPoolChunks, setDraftStartedPoolChunks] = useState([]);
  const [draftStartedPoolTotalChunks, setDraftStartedPoolTotalChunks] = useState(0);
  const [draftStartedMeta, setDraftStartedMeta] = useState(null);

  // Turn state
  const [turn, setTurn] = useState(null);
  const [turnTimer, setTurnTimer] = useState(0);
  const [isMyTurn, setIsMyTurn] = useState(false);
  const [turnOrder, setTurnOrder] = useState([]);
  const [draftRound, setDraftRound] = useState(1);
  const [currentTurnIndex, setCurrentTurnIndex] = useState(0);

  // Preference state
  const [preferred, setPreferred] = useState([]);
  const [preferencesSubmitted, setPreferencesSubmitted] = useState(false);
  const [preferredQueue, setPreferredQueue] = useState({});
  const [preferencesInitialized, setPreferencesInitialized] = useState(false);

  // UI state
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [previousUserCount, setPreviousUserCount] = useState(0);



  // Assemble pool when all chunks are received
  useEffect(() => {
    if (poolChunks.length && poolChunks.filter(Boolean).length === poolTotalChunks && poolTotalChunks > 0) {
      setPool(poolChunks.flat());
      setPoolChunks([]);
      setPoolTotalChunks(0);
    }
  }, [poolChunks, poolTotalChunks]);
  // Assemble selections when all chunks are received
  useEffect(() => {
    if (selectionsChunks.length && selectionsChunks.filter(Boolean).length === selectionsTotalChunks && selectionsTotalChunks > 0) {
      const allEntries = selectionsChunks.flat();
      setSelections(Object.fromEntries(allEntries));
      setSelectionsChunks([]);
      setSelectionsTotalChunks(0);
    }
  }, [selectionsChunks, selectionsTotalChunks]);

  // Assemble draft started pool and update state
  useEffect(() => {
    if (
      draftStartedPoolChunks.length &&
      draftStartedPoolChunks.filter(Boolean).length === draftStartedPoolTotalChunks &&
      draftStartedPoolTotalChunks > 0 &&
      draftStartedMeta
    ) {
      setPool(draftStartedPoolChunks.flat());
      setTurnOrder(draftStartedMeta.turnOrder);
      setCurrentPhase(draftStartedMeta.selectionPhase);
      setGameStarted(true);
      setTurn(draftStartedMeta.currentUser);
      setIsMyTurn(draftStartedMeta.currentUser === username);
      setDraftStartedPoolChunks([]);
      setDraftStartedPoolTotalChunks(0);
      setDraftStartedMeta(null);
      setSuccess("Draft started! Player pool loaded.");
    }
  }, [draftStartedPoolChunks, draftStartedPoolTotalChunks, draftStartedMeta, username]);

  // Assemble player-selected pool and selections and update state
  useEffect(() => {
    if (
      playerSelectedPoolChunks.length &&
      playerSelectedPoolChunks.filter(Boolean).length === playerSelectedPoolTotalChunks &&
      playerSelectedPoolTotalChunks > 0 &&
      playerSelectedSelectionsChunks.length &&
      playerSelectedSelectionsChunks.filter(Boolean).length === playerSelectedSelectionsTotalChunks &&
      playerSelectedSelectionsTotalChunks > 0 &&
      playerSelectedMeta
    ) {
      setPool(playerSelectedPoolChunks.flat());
      const allEntries = playerSelectedSelectionsChunks.flat();
      setSelections(Object.fromEntries(allEntries));
              setSuccess(`${playerSelectedMeta.selectedBy} selected ${playerSelectedMeta.player.player_id || playerSelectedMeta.player.PlayerID}`);
      setPlayerSelectedPoolChunks([]);
      setPlayerSelectedPoolTotalChunks(0);
      setPlayerSelectedSelectionsChunks([]);
      setPlayerSelectedSelectionsTotalChunks(0);
      setPlayerSelectedMeta(null);
    }
  }, [playerSelectedPoolChunks, playerSelectedPoolTotalChunks, playerSelectedSelectionsChunks, playerSelectedSelectionsTotalChunks, playerSelectedMeta]);

  // Initialize Ably connection
  useEffect(() => {
    const initAbly = async () => {
      try {
        // Generate a unique client ID
        const newClientId = `client_${Math.random().toString(36).substring(2, 15)}`;
        setClientId(newClientId);

        // Initialize Ably with improved configuration
        const ablyInstance = new Ably.Realtime({
          authCallback: async (tokenParams, callback) => {
            try {
              const response = await axios.post('http://localhost:8000/api/ably-token', {
                clientId: newClientId
              });
              callback(null, response.data);
            } catch (err) {
              callback(err);
            }
          },
          disconnectedRetryTimeout: 15000,
          suspendedRetryTimeout: 30000,
          fallbackHosts: ['a.ably-realtime.com', 'b.ably-realtime.com', 'c.ably-realtime.com', 'd.ably-realtime.com', 'e.ably-realtime.com'],
          timeout: 15000
        });

        setAbly(ablyInstance);

        // Handle connection events with detailed status
        ablyInstance.connection.on('connected', () => {
          console.log('🔗 Connected to Ably');
          setAblyConnectionStatus('connected');
          setAblyConnectionDetails({
            connectionId: ablyInstance.connection.id,
            clientId: ablyInstance.auth.clientId,
            timestamp: new Date().toISOString()
          });
        });

        ablyInstance.connection.on('disconnected', () => {
          console.log('🔌 Disconnected from Ably');
          setAblyConnectionStatus('disconnected');
        });

        ablyInstance.connection.on('failed', (err) => {
          console.error('❌ Ably connection failed:', err);
          setAblyConnectionStatus('failed');
          setAblyConnectionDetails({ error: err.message });
          setError('Connection failed. Please refresh the page.');
        });

        ablyInstance.connection.on('connecting', () => {
          console.log('🔄 Connecting to Ably...');
          setAblyConnectionStatus('connecting');
        });

        ablyInstance.connection.on('suspended', () => {
          console.log('⏸️ Ably connection suspended');
          setAblyConnectionStatus('suspended');
        });

        ablyInstance.connection.on('closed', () => {
          console.log('🔒 Ably connection closed');
          setAblyConnectionStatus('closed');
        });

      } catch (error) {
        console.error('Error initializing Ably:', error);
        setError('Failed to connect to server');
      }
    };

    initAbly();

    // Cleanup on unmount
    return () => {
      if (ably) {
        ably.close();
      }
    };
  }, []);

  // Clear messages after 3 seconds
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(""), 3000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(""), 3000);
      return () => clearTimeout(timer);
    }
  }, [success]);

  // Load player pool and room info automatically when component mounts
  useEffect(() => {
    const loadInitialData = async () => {
      console.log("🚀 Loading initial data...");
      await loadPlayerPoolDirectly();
      if (roomId && clientId) {
        await getRoomInfo();
      }
    };
    
    // Load data after a short delay to ensure everything is initialized
    const timer = setTimeout(loadInitialData, 1000);
    return () => clearTimeout(timer);
  }, [roomId, clientId]);

  // Join room
  const joinRoom = async () => {
    if (!username.trim() || !roomId.trim()) {
      setError("Please enter both username and room ID");
      return;
    }

    if (!ably || !clientId) {
      setError("Connection not ready. Please wait...");
      return;
    }

    try {
      console.log("🔗 Joining room:", roomId.trim(), "as", username.trim());
      
      const response = await axios.post('http://localhost:8000/api/join-room', {
        roomId: roomId.trim(),
        username: username.trim(),
        clientId: clientId
      });

      if (response.data.error) {
        setError(response.data.error);
        return;
      }

      if (response.data.status === 'generating_pool') {
        setSuccess("Generating player pool... Please wait.");
        // Poll for room readiness
        setTimeout(() => joinRoom(), 2000);
        return;
      }

      // Subscribe to room channel
      const roomChannel = ably.channels.get(`draft-room-${roomId.trim()}`);
      setChannel(roomChannel);

      // Subscribe to channel events
      roomChannel.subscribe('room-users', (message) => {
        console.log("👥 Room users updated:", message.data);
        const newUsers = message.data;
        const newUserCount = newUsers.length;
        
        // Show toast notification for user join/leave
        if (newUserCount > previousUserCount) {
          // User joined
          const newUser = newUsers.find(user => !users.find(u => u.username === user.username));
          if (newUser) {
            toast.info(`👋 ${newUser.username} joined the room!`, {
              position: "top-right",
              autoClose: 3000,
              hideProgressBar: false,
              closeOnClick: true,
              pauseOnHover: true,
              draggable: true,
              progress: undefined,
              icon: "👋"
            });
          }
        } else if (newUserCount < previousUserCount) {
          // User left
          const leftUser = users.find(user => !newUsers.find(u => u.username === user.username));
          if (leftUser) {
            toast.warning(`👋 ${leftUser.username} left the room`, {
              position: "top-right",
              autoClose: 3000,
              hideProgressBar: false,
              closeOnClick: true,
              pauseOnHover: true,
              draggable: true,
              progress: undefined,
              icon: "👋"
            });
          }
        }
        
        setPreviousUserCount(newUserCount);
        setUsers(newUsers);
      });

      roomChannel.subscribe('disconnected-users', (message) => {
        console.log("💔 Disconnected users:", message.data);
        setDisconnectedUsers(message.data);
      });

      roomChannel.subscribe('host-status', (message) => {
        console.log("👑 Host status:", message.data);
        const { isHost, started, clientId: hostClientId } = message.data;
        // Set host status for current user
        if (clientId === hostClientId) {
          console.log("✅ Setting host status for current user:", isHost);
          setIsHost(isHost);
          setGameStarted(started);
        }
      });

      // Subscribe to chunked pool
      roomChannel.subscribe('game-state-pool', (message) => {
        const { chunk, chunkIndex, totalChunks } = message.data;
        setPoolChunks(prev => {
          const next = [...prev];
          next[chunkIndex] = chunk;
          return next;
        });
        setPoolTotalChunks(totalChunks);
      });
      // Subscribe to chunked selections
      roomChannel.subscribe('game-state-selections', (message) => {
        const { chunk, chunkIndex, totalChunks } = message.data;
        setSelectionsChunks(prev => {
          const next = [...prev];
          next[chunkIndex] = chunk;
          return next;
        });
        setSelectionsTotalChunks(totalChunks);
      });
      // Subscribe to meta info
      roomChannel.subscribe('game-state-meta', (message) => {
        const { started, selectionPhase, turnOrder, currentTurnIndex, preferredQueue, maxMainPlayers, maxBenchPlayers, clientId: stateClientId } = message.data;
        if (typeof started === "boolean") setGameStarted(started);
        if (selectionPhase) setCurrentPhase(selectionPhase);
        if (turnOrder) setTurnOrder(turnOrder);
        
        // Update preferences from backend - but preserve local preferences and never clear them
        if (preferredQueue && clientId === stateClientId) {
          const backendPreferences = Array.isArray(preferredQueue) ? preferredQueue : [];
          console.log('📋 Received preferences from backend:', backendPreferences);
          console.log('📋 Current local preferences:', preferred);
          
          // Only initialize from backend if not already done, but never clear existing preferences
          if (!preferencesInitialized && backendPreferences.length > 0) {
            console.log('📋 Initializing preferences from backend');
            setPreferred(backendPreferences);
            setPreferencesInitialized(true);
          } else if (preferencesInitialized) {
            console.log('📋 Keeping current local preferences - not overwriting from backend');
            // Keep local preferences, don't overwrite with backend
          }
        }
        
        setPreferredQueue(preferredQueue);
        if (turnOrder && typeof currentTurnIndex === "number") {
          const currentTurnUser = turnOrder[currentTurnIndex];
          setTurn(currentTurnUser);
          setIsMyTurn(currentTurnUser === username);
        }
      });

      roomChannel.subscribe('draft-started-pool', (message) => {
        const { chunk, chunkIndex, totalChunks } = message.data;
        setDraftStartedPoolChunks(prev => {
          const next = [...prev];
          next[chunkIndex] = chunk;
          return next;
        });
        setDraftStartedPoolTotalChunks(totalChunks);
      });
      roomChannel.subscribe('draft-started-meta', (message) => {
        setDraftStartedMeta(message.data);
        if (message.data.draftRound) {
          setDraftRound(message.data.draftRound);
        }
        
        // Show toast notification for draft start
        const { turnOrder, currentUser, selectionPhase, draftRound } = message.data;
        const turnOrderText = turnOrder ? turnOrder.join(' → ') : '';
        
        toast.success(`🚀 Draft started! Round ${draftRound} - ${currentUser} goes first!`, {
          position: "top-right",
          autoClose: 6000,
          hideProgressBar: false,
          closeOnClick: true,
          pauseOnHover: true,
          draggable: true,
          progress: undefined,
          icon: "🚀"
        });
      });

      roomChannel.subscribe('turn-started', (message) => {
        console.log("🎯 Turn started:", message.data);
        const { currentUser, timeLeft, userId, draftRound: round, currentTurnIndex: turnIndex, turnOrder: order } = message.data;
        setTurn(currentUser);
        setIsMyTurn(userId === clientId);
        setTurnTimer(timeLeft);
        if (round) setDraftRound(round);
        if (turnIndex !== undefined) setCurrentTurnIndex(turnIndex);
        if (order) setTurnOrder(order);
        
        // Show toast notification for turn start
        const isMyTurnNow = userId === clientId;
        const toastMessage = isMyTurnNow 
          ? `🎯 It's your turn! Round ${round}, Pick ${turnIndex + 1} ⏰ ${timeLeft}s`
          : `👤 ${currentUser}'s turn - Round ${round}, Pick ${turnIndex + 1}`;
        
        const toastType = isMyTurnNow ? 'warning' : 'info';
        toast[toastType](toastMessage, {
          position: "top-right",
          autoClose: isMyTurnNow ? 8000 : 4000,
          hideProgressBar: false,
          closeOnClick: true,
          pauseOnHover: true,
          draggable: true,
          progress: undefined,
          icon: isMyTurnNow ? "🎯" : "👤"
        });
      });

      roomChannel.subscribe('player-selected-pool', (message) => {
        const { chunk, chunkIndex, totalChunks } = message.data;
        setPlayerSelectedPoolChunks(prev => {
          const next = [...prev];
          next[chunkIndex] = chunk;
          return next;
        });
        setPlayerSelectedPoolTotalChunks(totalChunks);
      });
      roomChannel.subscribe('player-selected-selections', (message) => {
        const { chunk, chunkIndex, totalChunks } = message.data;
        setPlayerSelectedSelectionsChunks(prev => {
          const next = [...prev];
          next[chunkIndex] = chunk;
          return next;
        });
        setPlayerSelectedSelectionsTotalChunks(totalChunks);
      });
      roomChannel.subscribe('player-selected-meta', (message) => {
        setPlayerSelectedMeta(message.data);
        
        // DO NOT remove player from preference list - keep preferences visible throughout the game
        const { player, selectedBy } = message.data;
        if (selectedBy === username && preferred.includes(player.PlayerID)) {
                  console.log(`🎯 ${player.player_id || player.PlayerID} was selected for your team from your preference list`);
        setSuccess(`🎯 ${player.player_id || player.PlayerID} was selected for your team from your preference list`);
        }
      });

      roomChannel.subscribe('draft-completed', (message) => {
        console.log("🏁 Draft completed:", message.data);
        
        // Show toast notification for draft completion
        toast.success("🏁 Draft completed! Check final selections.", {
          position: "top-right",
          autoClose: 10000,
          hideProgressBar: false,
          closeOnClick: true,
          pauseOnHover: true,
          draggable: true,
          progress: undefined,
          icon: "🏆"
        });
        
        setSuccess("Draft completed! Check final selections.");
      });

      roomChannel.subscribe('preferred-players-updated', (message) => {
        console.log("📝 Preferences updated:", message.data);
        const { message: updateMessage, preferredPlayers, userId } = message.data;
        
        // Only update local preferences if this is for the current user and we're not already initialized
        if (userId === clientId && !preferencesInitialized && preferredPlayers && Array.isArray(preferredPlayers)) {
          console.log("📝 Updating local preferences from backend update event");
          setPreferred(preferredPlayers);
          setPreferencesInitialized(true);
        }
        
        setSuccess(updateMessage);
      });

      roomChannel.subscribe('auto-select-failed', (message) => {
        console.log("❌ Auto-select failed:", message.data);
        const { username: failedUsername, reason } = message.data;
        
        // Show toast notification for auto-select failure
        const toastMessage = failedUsername === username 
          ? `❌ Your auto-pick failed: ${reason}`
          : `🤖 ${failedUsername}'s auto-pick failed: ${reason}`;
        
        toast.error(toastMessage, {
          position: "top-right",
          autoClose: 6000,
          hideProgressBar: false,
          closeOnClick: true,
          pauseOnHover: true,
          draggable: true,
          progress: undefined,
          icon: "❌"
        });
        
        if (failedUsername === username) {
          setError(`Auto-pick failed: ${reason}`);
        } else {
          setSuccess(`${failedUsername}'s auto-pick failed: ${reason}`);
        }
      });

      // Subscribe to refined essential events
      roomChannel.subscribe('room-created', (message) => {
        console.log("🏠 Room created with stats:", message.data);
        const { stats } = message.data;
        if (stats) {
          const toastMessage = `🏠 Room created! 📊 Total players: ${stats.totalPlayers}, Available: ${stats.availablePlayers}`;
          toast.info(toastMessage, {
            position: "top-right",
            autoClose: 4000,
            hideProgressBar: false,
            closeOnClick: true,
            pauseOnHover: true,
            draggable: true,
            progress: undefined,
            icon: "🏈"
          });
          setSuccess(`Room created! Total players: ${stats.totalPlayers}, Available: ${stats.availablePlayers}`);
        }
      });

      roomChannel.subscribe('player-picked', (message) => {
        console.log("🎯 Player picked with stats:", message.data);
        const { player, pickedBy, stats } = message.data;
        
        // Update local state with the picked player
        setPool(prevPool => prevPool.filter(p => p.PlayerID !== player.PlayerID));
        
        // Update selections
        setSelections(prevSelections => {
          const newSelections = { ...prevSelections };
          if (!newSelections[pickedBy]) {
            newSelections[pickedBy] = [];
          }
          newSelections[pickedBy].push(player);
          return newSelections;
        });
        
        // Show toast notification for player pick
        const toastMessage = stats 
                  ? `${pickedBy} picked ${player.player_id || player.PlayerID} (${player.Position})! 📊 Progress: ${stats.pickProgress}, Round: ${stats.roundProgress}`
        : `${pickedBy} picked ${player.player_id || player.PlayerID} (${player.Position})! 🎯`;
        
        toast.success(toastMessage, {
          position: "top-right",
          autoClose: 5000,
          hideProgressBar: false,
          closeOnClick: true,
          pauseOnHover: true,
          draggable: true,
          progress: undefined,
          icon: "🏈"
        });
        
        // Show stats if available
        if (stats) {
                  setSuccess(`${pickedBy} picked ${player.player_id || player.PlayerID}! Progress: ${stats.pickProgress}, Round: ${stats.roundProgress}`);
      } else {
        setSuccess(`${pickedBy} picked ${player.player_id || player.PlayerID}!`);
        }
      });

      setInRoom(true);
      setSuccess("Successfully joined room!");
      
      // Get room info including host status after joining
      setTimeout(() => {
        getRoomInfo();
      }, 500);

    } catch (error) {
      console.error('Error joining room:', error);
      setError("Error joining room: " + (error.response?.data?.error || error.message));
    }
  };

  // Create room
  const createRoom = async () => {
    if (!username.trim()) {
      setError("Please enter your username first");
      return;
    }

    try {
      const res = await axios.post("http://localhost:8000/api/create-room");
      setRoomId(res.data.roomId);
      setSuccess("Room created successfully!");
      console.log("🏠 Room created:", res.data.roomId);
    } catch (err) {
      setError("Error creating room: " + err.message);
    }
  };

  // Set preferred players
  const setPreferredPlayers = async () => {
    if (preferred.length === 0) {
      setError("Please select at least one preferred player");
      return;
    }

    if (!clientId || !roomId) {
      setError("Not connected to room");
      return;
    }

    // Debug: log the preferred list order before sending
    console.log('DEBUG: Preferred list being sent to backend:', preferred);

    try {
      console.log("📤 Sending preferred players:", preferred);
      const response = await axios.post('http://localhost:8000/api/set-preferred-players', {
        roomId,
        clientId,
        preferredPlayers: preferred,
      });

      if (response.data.error) {
        setError(response.data.error);
        return;
      }

      setPreferencesSubmitted(true);
      setSuccess("Preferences submitted successfully!");
    } catch (error) {
      setError("Error setting preferences: " + (error.response?.data?.error || error.message));
    }
  };

  // Check if all players have submitted preferences
  const allPreferencesSubmitted = users.length > 0 && users.every(user => user.preferencesSubmitted);

  // Check if a player can fit in the lineup
  const canPlayerFit = (playerPosition, currentSelections) => {
    const LINEUP = {
      QB: { main: 1, max: 3 },
      RB: { main: 2, max: 5 },
      WR: { main: 3, max: 6 },
      TE: { main: 1, max: 4 },
      K:  { main: 1, max: 3 },
      DST:{ main: 1, max: 3 },
      FLEX: { main: 1, max: 1 },
      BENCH: 2
    };
    const FLEX_ELIGIBLE = ["RB", "WR", "TE"];

    const slotCounts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, FLEX: 0, BENCH: 0 };
    
    // Count current selections using the exact same logic as slot assignment
    for (const player of currentSelections) {
      const pos = player.Position;
      if (slotCounts[pos] < LINEUP[pos].main) {
        slotCounts[pos]++;
        continue;
      }
      if (FLEX_ELIGIBLE.includes(pos) && slotCounts.FLEX < LINEUP.FLEX.main) {
        slotCounts.FLEX++;
        continue;
      }
      if (slotCounts.BENCH < LINEUP.BENCH && slotCounts[pos] < LINEUP[pos].max) {
        slotCounts.BENCH++;
        slotCounts[pos]++;
        continue;
      }
      // Player is in overflow - count them in position but not in valid slots
      slotCounts[pos]++;
    }

    // Check if new player can fit - simulate adding them
    const pos = playerPosition;
    
    // First check if position has reached max limit
    if (slotCounts[pos] >= LINEUP[pos].max) {
      return false; // Position is at max capacity
    }
    
    // Try main position first
    if (slotCounts[pos] < LINEUP[pos].main) {
      return true; // Can fit in main position
    }
    
    // Try FLEX if eligible
    if (FLEX_ELIGIBLE.includes(pos) && slotCounts.FLEX < LINEUP.FLEX.main) {
      return true; // Can fit in FLEX
    }
    
    // Try bench (only if bench has space and position isn't at max)
    if (slotCounts.BENCH < LINEUP.BENCH && slotCounts[pos] < LINEUP[pos].max) {
      return true; // Can fit on bench
    }
    
    return false; // Cannot fit anywhere
  };

  // Auto-select best available player using the new auto-pick service
  const autoSelectPlayer = async () => {
    if (!isMyTurn) {
      setError("It's not your turn!");
      return;
    }

    if (!clientId || !roomId) {
      setError("Not connected to room");
        return;
    }

    try {
      console.log("🤖 Requesting auto-pick from server...");
      const response = await axios.post('http://localhost:8000/api/auto-pick-player', {
        roomId,
        clientId
      });

      if (response.data.error) {
        setError(response.data.error);
          return;
        }

      if (response.data.selection) {
        const { player, wasPreferred, source } = response.data.selection;
        const sourceText = wasPreferred ? 'preferred list' : 'main pool';
        setSuccess(`Auto-picked ${player.player_id || player.PlayerID} (${player.Position}) from ${sourceText}`);
      } else {
        setSuccess("Auto-pick completed - no valid players available");
      }
    } catch (error) {
      setError("Error during auto-pick: " + (error.response?.data?.error || error.message));
    }
  };

  // Select a player during draft
  const selectPlayer = async (playerID) => {
    if (!isMyTurn) {
      setError("It's not your turn!");
      return;
    }

    if (!clientId || !roomId) {
      setError("Not connected to room");
      return;
    }

    // Check if this player can fit before making the API call
    const playerToSelect = pool.find(p => p.PlayerID === playerID);
    const myCurrentSelections = selections[username] || [];
    
    if (playerToSelect && !canPlayerFit(playerToSelect.Position, myCurrentSelections)) {
      setError(`Cannot select ${playerToSelect.Name} - no available slots for ${playerToSelect.Position} position!`);
      return;
    }

    try {
      console.log("🎯 Selecting player:", playerID);
      // Debug log for POST body
      console.log({ roomId, clientId, playerID });
      const response = await axios.post('http://localhost:8000/api/select-player', {
        roomId,
        clientId,
        playerID
      });

      if (response.data.error) {
        setError(response.data.error);
        return;
      }

      setSuccess("Player selected successfully!");
    } catch (error) {
      setError("Error selecting player: " + (error.response?.data?.error || error.message));
    }
  };

  // Start the draft (host only)
  const startDraft = async () => {
    console.log("🚀 Start Draft clicked");
    console.log("🔍 Current state - isHost:", isHost, "clientId:", clientId, "roomId:", roomId, "users.length:", users.length);

    if (!isHost) {
      console.log("❌ Not host - cannot start draft");
      setError("Only host can start the draft");
      return;
    }

    if (!clientId || !roomId) {
      console.log("❌ Not connected to room");
      setError("Not connected to room");
      return;
    }

    if (users.length < 2) {
      console.log("❌ Not enough users:", users.length);
      setError("Need at least 2 players to start");
      return;
    }

    try {
      console.log("🚀 Starting draft for room:", roomId);
      const response = await axios.post('http://localhost:8000/api/start-draft', {
        roomId,
        clientId
      });

      if (response.data.error) {
        console.log("❌ Start draft error:", response.data.error);
        setError(response.data.error);
        return;
      }

      console.log("✅ Draft started successfully:", response.data);
      setSuccess("Draft started successfully! Waiting for player pool...");
    } catch (error) {
      console.error("❌ Error starting draft:", error);
      setError("Error starting draft: " + (error.response?.data?.error || error.message));
    }
  };

  // Toggle player in preferred list
  const togglePreferred = (playerID) => {
    const player = pool.find(p => p.PlayerID === playerID);
    console.log('🎯 Toggle preferred called for:', playerID, player?.Name);
    console.log('🎯 Current preferred list:', preferred);
    console.log('🎯 Pool length:', pool.length);
    console.log('🎯 Player found in pool:', !!player);
    console.log('🎯 Preferences initialized:', preferencesInitialized);
    
    if (preferred.includes(playerID)) {
      const newPreferred = preferred.filter((id) => id !== playerID);
      setPreferred(newPreferred);
      console.log('❌ Removed from preferences. New list:', newPreferred);
      console.log('❌ New list length:', newPreferred.length);
    } else {
      const newPreferred = [...preferred, playerID];
      setPreferred(newPreferred);
      console.log('✅ Added to preferences. New list:', newPreferred);
      console.log('✅ New list length:', newPreferred.length);
      console.log('✅ Total players in preference list now:', newPreferred.length);
      console.log('✅ Setting preferences initialized to true');
      setPreferencesInitialized(true);
    }
  };

  // Test Ably connection
  const testAblyConnection = async () => {
    try {
      const response = await axios.get('http://localhost:8000/api/ably-test');
      if (response.data.status === 'success') {
        setSuccess('Ably connection test successful!');
        console.log('Ably test response:', response.data);
      } else {
        setError('Ably connection test failed');
      }
    } catch (error) {
      setError('Ably connection test failed: ' + (error.response?.data?.error || error.message));
    }
  };

  // Get Ably status
  const getAblyStatus = async () => {
    try {
      const response = await axios.get('http://localhost:8000/api/ably-status');
      console.log('Ably status:', response.data);
      setSuccess('Ably status: ' + response.data.message);
    } catch (error) {
      setError('Failed to get Ably status: ' + (error.response?.data?.error || error.message));
    }
  };

  // Handle disconnect
  useEffect(() => {
    const handleBeforeUnload = async () => {
      if (clientId && roomId) {
        try {
          await axios.post('http://localhost:8000/api/disconnect', {
            roomId,
            clientId
          });
        } catch (error) {
          console.error('Error disconnecting:', error);
        }
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [clientId, roomId]);

  // Timer countdown effect
  useEffect(() => {
    if (turnTimer > 0 && gameStarted) {
      const interval = setInterval(() => {
        setTurnTimer((prev) => {
          if (prev <= 1) {
            if (isMyTurn) {
              setIsMyTurn(false);
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [turnTimer, gameStarted, isMyTurn]);

  // Get current user's selections for display
  const mySelections = selections[username] || [];

  // Get preferred player details - include both pool and selected players
  const preferredPlayerDetails = (Array.isArray(preferred) ? preferred : []).map(pid => {
    // First look in the pool
    let player = pool.find(p => p.PlayerID === pid);
    
    // If not found in pool, look in user's selections (for selected players)
    if (!player) {
      player = mySelections.find(p => p.PlayerID === pid);
    }
    
    // Also check other users' selections in case the player was selected by someone else
    if (!player) {
      for (const [username, userSelections] of Object.entries(selections)) {
        player = userSelections.find(p => p.PlayerID === pid);
        if (player) break;
      }
    }
    
    console.log('🔍 Looking for player ID:', pid, 'Found in pool:', !!pool.find(p => p.PlayerID === pid), 'Found in selections:', !!mySelections.find(p => p.PlayerID === pid));
    return player;
  }).filter(Boolean);

  // Debug: Log preference list state
  console.log('🔍 DEBUG: Preference list state:', {
    preferredLength: preferred.length,
    preferred: preferred,
    preferencesInitialized,
    poolLength: pool.length,
    mySelectionsLength: mySelections.length
  });

  // Group pool by position for preferences UI
  const poolByPosition = pool.reduce((acc, player) => {
    if (!acc[player.Position]) acc[player.Position] = [];
    acc[player.Position].push(player);
    return acc;
  }, {});
  
  console.log('🔍 Pool length:', pool.length);
  console.log('🔍 PoolByPosition keys:', Object.keys(poolByPosition));
  console.log('🔍 PoolByPosition counts:', Object.fromEntries(
    Object.entries(poolByPosition).map(([pos, players]) => [pos, players.length])
  ));

  // Auto-save preferences when they change - for backend storage (with debounce)
  useEffect(() => {
    if (preferred.length >= 0 && clientId && roomId && preferencesInitialized) {
      // Debounce the save to prevent too frequent API calls
      const timeoutId = setTimeout(async () => {
        try {
          console.log('🔄 Saving preferences to backend:', preferred);
          
          // Only save if we have preferences to save
          if (preferred.length > 0) {
            const response = await axios.post('http://localhost:8000/api/set-preferred-players', {
              roomId,
              clientId,
              preferredPlayers: preferred,
            });
            
            if (response.data.error) {
              console.error('❌ Error saving preferences:', response.data.error);
            } else {
              console.log('✅ Preferences saved to backend successfully');
            }
          } else {
            console.log('🔄 No preferences to save (empty list)');
          }
        } catch (error) {
          console.error('❌ Error saving preferences:', error);
        }
      }, 2000); // 2 second debounce to prevent conflicts
      
      return () => clearTimeout(timeoutId);
    }
  }, [preferred, clientId, roomId, preferencesInitialized]);

  // Load preferences from backend when joining room
  useEffect(() => {
    if (inRoom && clientId && roomId && !preferencesInitialized) {
      // Initialize preferences as empty - backend will send current state
      setPreferencesInitialized(true);
      console.log('📋 Ready to receive preferences from backend');
    }
  }, [inRoom, clientId, roomId, preferencesInitialized]);

  // Debug: Log when preferences change
  useEffect(() => {
    console.log('🔍 DEBUG: Preferences changed:', {
      preferredLength: preferred.length,
      preferred: preferred,
      preferencesInitialized
    });
  }, [preferred, preferencesInitialized]);

  // Ensure preference list is maintained when game state updates
  useEffect(() => {
    if (preferencesInitialized && preferred.length > 0) {
      console.log('🔍 Ensuring preference list is maintained:', preferred.length, 'players');
      console.log('🔍 Current preference list:', preferred);
      // The preference list should persist throughout the game
      // No need to clear or modify it based on game state changes
    }
  }, [gameStarted, pool, selections, preferencesInitialized, preferred.length]);

  // --- DRAG AND DROP for preference reordering ---
  const dragItem = useRef();
  const dragOverItem = useRef();
  const handleDragStart = (index) => { dragItem.current = index; };
  const handleDragEnter = (index) => { dragOverItem.current = index; };
  const handleDragEnd = () => {
    const list = [...preferred];
    const dragged = list.splice(dragItem.current, 1)[0];
    list.splice(dragOverItem.current, 0, dragged);
    setPreferred(list);
    dragItem.current = null;
    dragOverItem.current = null;
  };

  // Load player pool directly from REST API (bypasses Ably issues)
  const loadPlayerPoolDirectly = async () => {
    try {
      console.log("🔄 Loading player pool directly from REST API...");
      setError(""); // Clear any previous errors
      
      const response = await axios.get('http://localhost:8000/api/players/pool');
      
      if (response.data.success) {
        const { players, count } = response.data;
        console.log(`✅ Loaded ${count} players directly from API`);
        setPool(players);
        setSuccess(`Successfully loaded ${count} players!`);
        return true;
      } else {
        throw new Error(response.data.error || 'Failed to load players');
      }
    } catch (error) {
      console.error("❌ Error loading player pool:", error);
      setError(`Failed to load players: ${error.message}`);
      return false;
    }
  };

  // Get room info including host status and stats (bypasses Ably)
  const getRoomInfo = async () => {
    if (!roomId || !clientId) return;
    
    try {
      console.log("🔄 Getting room info from REST API...");
      const response = await axios.get(`http://localhost:8000/api/room/${roomId}/info?clientId=${clientId}`);
      
      if (response.data) {
        const { isHost, users, started, stats } = response.data;
        console.log(`✅ Room info loaded - isHost: ${isHost}, users: ${users.length}, started: ${started}`);
        console.log(`📊 Room stats:`, stats);
        console.log(`🔍 Setting host status to: ${isHost} for clientId: ${clientId}`);
        setIsHost(isHost);
        setUsers(users);
        setGameStarted(started);
        
        // Display stats if available
        if (stats && stats.totalPlayers > 0) {
          setSuccess(`Room loaded! Players: ${stats.availablePlayers}/${stats.totalPlayers} available, Round: ${stats.currentRound}/${stats.maxRounds}`);
        }
        return true;
      }
    } catch (error) {
      console.error("❌ Error getting room info:", error);
      return false;
    }
  };

  const reloadPlayers = async () => {
    try {
      // Load players directly from REST API instead of Ably
      const success = await loadPlayerPoolDirectly();
      if (success) {
        setSuccess("Player pool reloaded successfully!");
      }
    } catch (err) {
      setError("Failed to reload player pool.");
    }
  };

  // Render login screen
  if (!inRoom) {
    return (
      <div
        style={{
          padding: "2rem",
          fontFamily: "Arial, sans-serif",
          maxWidth: "500px",
          margin: "0 auto",
        }}
      >
        <h2>🏈 NFL Draft Room</h2>

        {error && (
          <div
            style={{
              backgroundColor: "#ffebee",
              color: "#c62828",
              padding: "1rem",
              borderRadius: "4px",
              marginBottom: "1rem",
            }}
          >
            {error}
          </div>
        )}

        {success && (
          <div
            style={{
              backgroundColor: "#e8f5e8",
              color: "#2e7d32",
              padding: "1rem",
              borderRadius: "4px",
              marginBottom: "1rem",
            }}
          >
            {success}
          </div>
        )}

        <div style={{ marginBottom: "1rem" }}>
          <input
            placeholder="Enter your username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={{
              padding: "0.5rem",
              marginRight: "0.5rem",
              borderRadius: "4px",
              border: "1px solid #ccc",
              width: "200px",
            }}
          />
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <input
            placeholder="Enter room ID"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            style={{
              padding: "0.5rem",
              marginRight: "0.5rem",
              borderRadius: "4px",
              border: "1px solid #ccc",
              width: "200px",
            }}
          />
          <button
            onClick={joinRoom}
            style={{
              padding: "0.5rem 1rem",
              backgroundColor: "#4caf50",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Join Room
          </button>
        </div>

        <button
          onClick={createRoom}
          style={{
            padding: "0.5rem 1rem",
            backgroundColor: "#2196f3",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          Create New Room
        </button>
      </div>
    );
  }

  // Render game screen
  return (
    <div style={{ padding: "2rem", fontFamily: "Arial, sans-serif" }}>
      {/* Header */}
      <div style={{ marginBottom: "2rem" }}>
        <h2>
          🏈 NFL Draft - Room: {roomId} {isHost && "👑"}
        </h2>

        {/* Ably Connection Status */}
        <div style={{ 
          marginBottom: "1rem", 
          padding: "0.5rem", 
          borderRadius: "4px",
          backgroundColor: 
            ablyConnectionStatus === 'connected' ? '#e8f5e8' :
            ablyConnectionStatus === 'connecting' ? '#fff3cd' :
            ablyConnectionStatus === 'failed' ? '#ffebee' :
            ablyConnectionStatus === 'suspended' ? '#fff3cd' :
            '#f5f5f5',
          border: `1px solid ${
            ablyConnectionStatus === 'connected' ? '#4caf50' :
            ablyConnectionStatus === 'connecting' ? '#ff9800' :
            ablyConnectionStatus === 'failed' ? '#f44336' :
            ablyConnectionStatus === 'suspended' ? '#ff9800' :
            '#ccc'
          }`
        }}>
          <strong>Ably Connection:</strong> 
          <span style={{ 
            color: 
              ablyConnectionStatus === 'connected' ? '#2e7d32' :
              ablyConnectionStatus === 'connecting' ? '#f57c00' :
              ablyConnectionStatus === 'failed' ? '#c62828' :
              ablyConnectionStatus === 'suspended' ? '#f57c00' :
              '#666'
          }}>
            {ablyConnectionStatus === 'connected' && '🟢 Connected'}
            {ablyConnectionStatus === 'connecting' && '🟡 Connecting...'}
            {ablyConnectionStatus === 'disconnected' && '🔴 Disconnected'}
            {ablyConnectionStatus === 'failed' && '🔴 Failed'}
            {ablyConnectionStatus === 'suspended' && '🟡 Suspended'}
            {ablyConnectionStatus === 'closed' && '🔴 Closed'}
          </span>
          {ablyConnectionDetails.connectionId && (
            <span style={{ marginLeft: "1rem", fontSize: "0.9em", color: "#666" }}>
              ID: {ablyConnectionDetails.connectionId}
            </span>
          )}
          {ablyConnectionDetails.clientId && (
            <span style={{ marginLeft: "1rem", fontSize: "0.9em", color: "#666" }}>
              Client: {ablyConnectionDetails.clientId}
            </span>
          )}
          <div style={{ marginTop: "0.5rem" }}>
            <button
              onClick={testAblyConnection}
              style={{
                padding: "0.25rem 0.5rem",
                marginRight: "0.5rem",
                backgroundColor: "#2196f3",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "0.8em"
              }}
            >
              🧪 Test Connection
            </button>
            <button
              onClick={getAblyStatus}
              style={{
                padding: "0.25rem 0.5rem",
                backgroundColor: "#4caf50",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "0.8em"
              }}
            >
              📊 Get Status
            </button>
          </div>
        </div>

        {error && (
          <div
            style={{
              backgroundColor: "#ffebee",
              color: "#c62828",
              padding: "1rem",
              borderRadius: "4px",
              marginBottom: "1rem",
            }}
          >
            {error}
          </div>
        )}

        {success && (
          <div
            style={{
              backgroundColor: "#e8f5e8",
              color: "#2e7d32",
              padding: "1rem",
              borderRadius: "4px",
              marginBottom: "1rem",
            }}
          >
            {success}
          </div>
        )}
      </div>

      {/* Game Status */}
      <div
        style={{
          backgroundColor: "#f5f5f5",
          padding: "1rem",
          borderRadius: "8px",
          marginBottom: "2rem",
        }}
      >
        <h3>📊 Game Status</h3>
        <p>
          <strong>Status:</strong>{" "}
          {gameStarted
            ? `🎮 Playing (${currentPhase} phase) - Round ${draftRound}`
            : "⏳ Waiting to start"}
        </p>
        <p>
          <strong>Your Preferences:</strong>{" "}
          {preferencesSubmitted ? "✅ Submitted" : "❌ Not submitted"}
          <span style={{ color: "#666", fontSize: "0.9em", marginLeft: "0.5rem" }}>
            (Auto-pick uses preference list FIRST)
          </span>
        </p>
        <p>
          <strong>Your Selections:</strong> {mySelections.length} players
        </p>
        <p>
          <strong>Players:</strong> {users.length} active,{" "}
          {disconnectedUsers.length} disconnected
        </p>
        <p>
          <strong>Available Players:</strong> {pool.length}
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button
            onClick={loadPlayerPoolDirectly}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: '#2196f3',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            🔄 Reload Players ({pool.length})
          </button>
          <button
            onClick={getRoomInfo}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: '#4caf50',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            🔄 Refresh Room Info
          </button>
          <button
            onClick={() => {
              console.log("🔍 DEBUG STATE:");
              console.log("- isHost:", isHost);
              console.log("- clientId:", clientId);
              console.log("- roomId:", roomId);
              console.log("- users.length:", users.length);
              console.log("- gameStarted:", gameStarted);
              alert(`Debug Info:\nisHost: ${isHost}\nclientId: ${clientId}\nroomId: ${roomId}\nusers: ${users.length}\ngameStarted: ${gameStarted}`);
            }}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: '#ff9800',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            🔍 Debug State
          </button>
        </div>

        {gameStarted && turn && (
          <div
            style={{
              backgroundColor: isMyTurn ? "#ffcdd2" : "#e3f2fd",
              padding: "1rem",
              borderRadius: "4px",
              marginTop: "1rem",
            }}
          >
            <h4
              style={{
                margin: "0",
                color: isMyTurn ? "#c62828" : "#1976d2",
              }}
            >
              {isMyTurn
                ? `⏰ YOUR TURN! (${turnTimer}s remaining)`
                : `⏱️ ${turn}'s turn (${turnTimer}s remaining)`}
            </h4>
          </div>
        )}
      </div>

      {/* Players List */}
      <div style={{ marginBottom: "2rem" }}>
        <h3>👥 Players ({users.length})</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          {users.map((user) => (
            <span
              key={user.username}
              style={{
                backgroundColor: user.preferencesSubmitted
                  ? "#e8f5e8"
                  : "#fff3cd",
                padding: "0.25rem 0.5rem",
                borderRadius: "4px",
                border: `1px solid ${
                  user.preferencesSubmitted ? "#4caf50" : "#ff9800"
                }`,
              }}
            >
              {user.username} {user.preferencesSubmitted ? "✅" : "⏳"}
            </span>
          ))}
        </div>

        {disconnectedUsers.length > 0 && (
          <div style={{ marginTop: "1rem" }}>
            <h4>💔 Disconnected ({disconnectedUsers.length})</h4>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {disconnectedUsers.map((user) => (
                <span
                  key={user.username}
                  style={{
                    backgroundColor: "#ffebee",
                    padding: "0.25rem 0.5rem",
                    borderRadius: "4px",
                  }}
                >
                  {user.username}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Turn Order */}
      {gameStarted && turnOrder.length > 0 && (
        <div style={{ marginBottom: "2rem" }}>
          <h3>📋 Snake Draft Order - Round {draftRound}</h3>
          <p style={{ color: "#666", fontSize: "0.9em", marginBottom: "0.5rem" }}>
            {draftRound % 2 === 1 ? "🔄 Normal order (1→2→3→4)" : "🔄 Reversed order (4→3→2→1)"}
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {turnOrder.map((playerName, index) => (
              <span
                key={index}
                style={{
                  backgroundColor: playerName === turn ? "#4caf50" : "#f0f0f0",
                  color: playerName === turn ? "white" : "black",
                  padding: "0.25rem 0.5rem",
                  borderRadius: "4px",
                  fontWeight: playerName === turn ? "bold" : "normal",
                }}
              >
                {index + 1}. {playerName}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Preferences: Always visible, even during the draft */}
        <div id="preferences-section" style={{ 
          marginBottom: '2rem',
          backgroundColor: '#f8f9fa',
          border: '2px solid #4caf50',
          borderRadius: '8px',
          padding: '1rem',
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
        }}>
        <h3 style={{ 
          color: '#2e7d32', 
          marginBottom: '0.5rem',
          fontSize: '1.4em',
          textAlign: 'center'
        }}>⭐ Your Preferences ({preferred.length}) - Always Visible & Functional</h3>
        <p style={{ 
          color: "#1976d2", 
          fontStyle: "italic", 
          marginBottom: '1rem',
          textAlign: 'center',
          fontSize: '1.1em'
        }}>
          Click any player to add them to your preference list. Preferences are stored in the backend and used for auto-pick functionality. 
          <strong>This list remains visible throughout the entire game and is used first for auto-pick selections.</strong>
        </p>
          {pool.length === 0 ? (
            <div style={{ 
              backgroundColor: '#fff3cd', 
              padding: '1rem', 
              borderRadius: '4px', 
              marginBottom: '1rem' 
            }}>
              <p>⏳ Loading player pool...</p>
              <button
                onClick={loadPlayerPoolDirectly}
                style={{
                  padding: '0.5rem 1rem',
                  backgroundColor: '#2196f3',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  marginTop: '0.5rem'
                }}
              >
                🔄 Load Players Manually
              </button>
            </div>
          ) : (
            <div style={{
              display: 'flex',
              gap: '1rem',
              flexWrap: 'wrap',
              marginBottom: '1rem',
            }}>
              {Object.keys(poolByPosition).sort().map(position => (
                <div key={position} style={{
                  flex: '1 1 180px',
                  minWidth: '180px',
                  maxWidth: '220px',
                  backgroundColor: '#f9f9f9',
                  border: '1px solid #ccc',
                  borderRadius: '8px',
                  padding: '0.5rem',
                  maxHeight: '320px',
                  overflowY: 'auto',
                }}>
                  <h4 style={{
                    margin: '0 0 0.5rem 0',
                    textAlign: 'center',
                    background: '#e3f2fd',
                    borderRadius: '4px',
                    padding: '0.25rem 0',
                    fontSize: '1.1em',
                    letterSpacing: '1px',
                  }}>{position}</h4>
                  {poolByPosition[position].map(player => {
                    const isSelected = preferred.includes(player.PlayerID);
                    const isDisabled = false;
                    const priority = preferred.indexOf(player.PlayerID) + 1;
                    const isOnMyTeam = (selections[username] || []).some(p => p.PlayerID === player.PlayerID);
                    console.log(`🔍 Rendering preference button for ${player.player_id || player.PlayerID}: isSelected=${isSelected}, isDisabled=${isDisabled}, priority=${priority}, isOnMyTeam=${isOnMyTeam}`);
                    return (
                      <button
                        key={player.PlayerID}
                        onClick={() => togglePreferred(player.PlayerID)}
                        disabled={isDisabled}
                        style={{
                          display: 'block',
                          width: '100%',
                          margin: '5px 0',
                          padding: '0.5rem',
                          backgroundColor: isSelected ? '#4caf50' : '#fff',
                          color: isSelected ? 'white' : 'black',
                          border: isSelected ? '2px solid #45a049' : '1px solid #ddd',
                          borderRadius: '4px',
                          cursor: isDisabled ? 'not-allowed' : 'pointer',
                          textAlign: 'left',
                          opacity: isDisabled ? 0.5 : 1,
                          fontWeight: isSelected ? 'bold' : 'normal',
                        }}
                      >
                        {isSelected && `${priority}. `}
                        {player.player_id || player.PlayerID}
                        {isSelected && ' ✅'}
                        {isOnMyTeam && ' 🏈'}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        {/* Selected Preferences with drag-and-drop */}
          {console.log('🔍 Rendering preference list. Preferred length:', preferred.length, 'Preferred:', preferred)}
          <div style={{ 
            marginBottom: "1rem",
            backgroundColor: preferred.length > 0 ? '#e8f5e8' : '#fff3cd',
            border: '2px solid #4caf50',
            borderRadius: '8px',
            padding: '1.5rem',
            boxShadow: '0 3px 6px rgba(0,0,0,0.1)'
          }}>
            <h4 style={{ 
              color: '#2e7d32',
              marginBottom: '0.5rem',
              fontSize: '1.2em',
              textAlign: 'center'
            }}>📋 ALL YOUR SELECTED PLAYERS ({preferred.length}):</h4>
            <p style={{ 
              textAlign: 'center',
              color: '#2e7d32',
              marginBottom: '1rem',
              fontSize: '1em',
              fontWeight: 'bold'
            }}>
              {preferred.length > 0 
                ? `You have selected ${preferred.length} player${preferred.length !== 1 ? 's' : ''} for your preference list. Auto-pick will use this list FIRST:`
                : 'No players selected yet. Click on players above to add them to your preference list. Auto-pick will use this list FIRST when it\'s your turn.'
              }
            </p>
                        {preferred.length > 0 && (
            <ol style={{ 
              paddingLeft: 20,
              margin: 0
            }}>
                {preferredPlayerDetails.map((player, index) => {
                  const isOnMyTeam = (selections[username] || []).some(p => p.PlayerID === player.PlayerID);
                  const isSelectedByOther = !isOnMyTeam && Object.values(selections).some(userSelections => 
                    userSelections.some(p => p.PlayerID === player.PlayerID)
                  );
                  const isInPool = pool.some(p => p.PlayerID === player.PlayerID);
                  
                  return (
                    <li
                      key={player.PlayerID}
                      draggable={isInPool}
                      onDragStart={() => isInPool && handleDragStart(index)}
                      onDragEnter={() => isInPool && handleDragEnter(index)}
                      onDragEnd={isInPool ? handleDragEnd : undefined}
                      style={{
                        marginBottom: "0.5rem",
                        background: isOnMyTeam ? "#e8f5e8" : isSelectedByOther ? "#fff3cd" : "#ffffff",
                        borderRadius: 6,
                        padding: "0.75rem",
                        cursor: isInPool ? "grab" : "default",
                        border: isOnMyTeam ? "2px solid #2e7d32" : isSelectedByOther ? "2px solid #ff9800" : "2px solid #4caf50",
                        display: "flex",
                        alignItems: "center",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                        fontSize: "1.1em",
                        fontWeight: "bold",
                        opacity: isInPool ? 1 : 0.7
                      }}
                    >
                      <span style={{ flex: 1 }}>
                        <strong>{index + 1}. {player.player_id || player.PlayerID}</strong> - {player.Position}
                        <span style={{ color: "#666", marginLeft: 8 }}>
                          ({index < 5 ? "Main" : "Bench"})
                        </span>
                        {isOnMyTeam && <span style={{ color: "#2e7d32", marginLeft: 8, fontWeight: "bold" }}>🏈 ON YOUR TEAM</span>}
                        {isSelectedByOther && <span style={{ color: "#ff9800", marginLeft: 8, fontWeight: "bold" }}>📋 SELECTED BY OTHER</span>}
                        {!isInPool && !isOnMyTeam && !isSelectedByOther && <span style={{ color: "#999", marginLeft: 8, fontWeight: "bold" }}>❓ NOT FOUND</span>}
                      </span>
                      {isInPool && <span style={{ color: "#aaa", fontSize: 14, marginLeft: 8 }}>☰</span>}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
      </div>

      {/* Pre-Game: Set Preferences */}
      {!gameStarted && (
        <div id="preferences-section" style={{ marginBottom: '2rem' }}>
          {/* This section is now redundant as preferences are always visible */}
          {/* <h3>⭐ Set Your Preferences ({preferred.length})</h3> */}
          {/* <p>Select as many players as you like in order of preference. Drag to reorder.</p> */}
          {/* {pool.length === 0 ? ( */}
          {/*   <div style={{  */}
          {/*     backgroundColor: '#fff3cd',  */}
          {/*     padding: '1rem',  */}
          {/*     borderRadius: '4px',  */}
          {/*     marginBottom: '1rem'  */}
          {/*   }}> */}
          {/*     <p>⏳ Loading player pool...</p> */}
          {/*   </div> */}
          {/* ) : ( */}
          {/*   <div style={{ */}
          {/*     display: 'flex', */}
          {/*     gap: '1rem', */}
          {/*     flexWrap: 'wrap', */}
          {/*     marginBottom: '1rem', */}
          {/*   }}> */}
          {/*     {Object.keys(poolByPosition).sort().map(position => ( */}
          {/*       <div key={position} style={{ */}
          {/*         flex: '1 1 180px', */}
          {/*         minWidth: '180px', */}
          {/*         maxWidth: '220px', */}
          {/*         backgroundColor: '#f9f9f9', */}
          {/*         border: '1px solid #ccc', */}
          {/*         borderRadius: '8px', */}
          {/*         padding: '0.5rem', */}
          {/*         maxHeight: '320px', */}
          {/*         overflowY: 'auto', */}
          {/*       }}> */}
          {/*         <h4 style={{ */}
          {/*           margin: '0 0 0.5rem 0', */}
          {/*           textAlign: 'center', */}
          {/*           background: '#e3f2fd', */}
          {/*           borderRadius: '4px', */}
          {/*           padding: '0.25rem 0', */}
          {/*           fontSize: '1.1em', */}
          {/*           letterSpacing: '1px', */}
          {/*         }}>{position}</h4> */}
          {/*         {poolByPosition[position].map(player => { */}
          {/*           const isSelected = preferred.includes(player.PlayerID); */}
          {/*           const isDisabled = false; */}
          {/*           const priority = preferred.indexOf(player.PlayerID) + 1; */}
          {/*           return ( */}
          {/*             <button */}
          {/*               key={player.PlayerID} */}
          {/*               onClick={() => togglePreferred(player.PlayerID)} */}
          {/*               disabled={isDisabled} */}
          {/*               style={{ */}
          {/*                 display: 'block', */}
          {/*                 width: '100%', */}
          {/*                 margin: '5px 0', */}
          {/*                 padding: '0.5rem', */}
          {/*                 backgroundColor: isSelected ? '#4caf50' : '#fff', */}
          {/*                 color: isSelected ? 'white' : 'black', */}
          {/*                 border: isSelected ? '2px solid #45a049' : '1px solid #ddd', */}
          {/*                 borderRadius: '4px', */}
          {/*                 cursor: isDisabled ? 'not-allowed' : 'pointer', */}
          {/*                 textAlign: 'left', */}
          {/*                 opacity: isDisabled ? 0.5 : 1, */}
          {/*                 fontWeight: isSelected ? 'bold' : 'normal', */}
          {/*               }} */}
          {/*             > */}
          {/*               {isSelected && `${priority}. `} */}
          {/*               {player.Name} */}
          {/*               {isSelected && ' ✅'} */}
          {/*             </button> */}
          {/*           ); */}
          {/*         })} */}
          {/*       </div> */}
          {/*     ))} */}
          {/*   </div> */}
          {/* )} */}

          {/* Selected Preferences with drag-and-drop */}
          {/* This section is now redundant as preferences are always visible */}
          {/* {preferred.length > 0 && ( */}
          {/*   <div style={{ marginBottom: "1rem" }}> */}
          {/*     <h4>Your Preferences ({preferred.length}):</h4> */}
          {/*     <ol style={{ paddingLeft: 20 }}> */}
          {/*       {preferredPlayerDetails.map((player, index) => ( */}
          {/*         <li */}
          {/*           key={player.PlayerID} */}
          {/*           draggable */}
          {/*           onDragStart={() => handleDragStart(index)} */}
          {/*           onDragEnter={() => handleDragEnter(index)} */}
          {/*           onDragEnd={handleDragEnd} */}
          {/*           style={{ */}
          {/*             marginBottom: "0.25rem", */}
          {/*             background: "#f1f8e9", */}
          {/*             borderRadius: 4, */}
          {/*             padding: "0.25rem 0.5rem", */}
          {/*             cursor: "grab", */}
          {/*             border: "1px solid #c5e1a5", */}
          {/*             display: "flex", */}
          {/*             alignItems: "center" */}
          {/*           }} */}
          {/*         > */}
          {/*           <span style={{ flex: 1 }}> */}
          {/*             {player.Name} - {player.Position} */}
          {/*             <span style={{ color: "#666", marginLeft: 8 }}> */}
          {/*               ({index < 5 ? "Main" : "Bench"}) */}
          {/*             </span> */}
          {/*           </span> */}
          {/*           <span style={{ color: "#aaa", fontSize: 14, marginLeft: 8 }}>☰</span> */}
          {/*         </li> */}
          {/*       ))} */}
          {/*     </ol> */}
          {/*   </div> */}
          {/* )} */}

          {/* No submit button! Preferences are live. */}
          {/* Start Draft button: allow even if preferences are empty */}
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            {isHost && (
              <button
                onClick={startDraft}
                disabled={users.length < 2}
                style={{
                  padding: '0.75rem 1.5rem',
                  backgroundColor: (users.length >= 2) ? '#2196f3' : '#ccc',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: (users.length >= 2) ? 'pointer' : 'not-allowed',
                  fontSize: '1rem'
                }}
              >
                🚀 Start Draft
              </button>
            )}
          </div>

          {isHost && users.length < 2 && (
            <p style={{ color: "#f57c00", marginTop: "0.5rem" }}>
              ⚠️ Need at least 2 players to start the draft
            </p>
          )}
        </div>
      )}

      {/* During Game: Player Selection */}
      {gameStarted && (
        <div id="selection-section" style={{ marginBottom: "2rem" }}>
          <h3>Player Selection</h3>
          
          {/* Lineup Status */}
          {(() => {
            const myCurrentSelections = selections[username] || [];
            const LINEUP = {
              QB: { main: 1, max: 3 },
              RB: { main: 2, max: 5 },
              WR: { main: 3, max: 6 },
              TE: { main: 1, max: 4 },
              K:  { main: 1, max: 3 },
              DST:{ main: 1, max: 3 },
              FLEX: { main: 1, max: 1 },
              BENCH: 2
            };
            const FLEX_ELIGIBLE = ["RB", "WR", "TE"];
            const slotCounts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, FLEX: 0, BENCH: 0 };
            
            // Count current slots using proper logic
            for (const player of myCurrentSelections) {
              const pos = player.Position;
              
              // Check if position has reached max limit
              if (slotCounts[pos] >= LINEUP[pos].max) {
                continue; // Skip overflow players
              }
              
              if (slotCounts[pos] < LINEUP[pos].main) {
                slotCounts[pos]++;
                continue;
              }
              if (FLEX_ELIGIBLE.includes(pos) && slotCounts.FLEX < LINEUP.FLEX.main) {
                slotCounts.FLEX++;
                continue;
              }
              if (slotCounts.BENCH < LINEUP.BENCH && slotCounts[pos] < LINEUP[pos].max) {
                slotCounts.BENCH++;
                slotCounts[pos]++;
                continue;
              }
            }

            // Calculate available slots more accurately
            const availableSlots = [];
            Object.keys(LINEUP).forEach(pos => {
              if (pos === 'FLEX' || pos === 'BENCH') return;
              const available = LINEUP[pos].max - slotCounts[pos];
              if (available > 0) {
                const mainNeeded = Math.max(0, LINEUP[pos].main - slotCounts[pos]);
                const benchAvailable = Math.max(0, available - mainNeeded);
                if (mainNeeded > 0) {
                  availableSlots.push(`${pos}: ${mainNeeded} main`);
                }
                if (benchAvailable > 0) {
                  availableSlots.push(`${pos}: ${benchAvailable} bench`);
                }
              }
            });
            
            const flexAvailable = LINEUP.FLEX.main - slotCounts.FLEX;
            const benchAvailable = LINEUP.BENCH - slotCounts.BENCH;
            
            if (flexAvailable > 0) availableSlots.push(`FLEX: ${flexAvailable}`);
            if (benchAvailable > 0) availableSlots.push(`BENCH: ${benchAvailable}`);

            // Count valid players only
            const validPlayerCount = myCurrentSelections.filter(player => {
              const tempSlotCounts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, FLEX: 0, BENCH: 0 };
              let playerCanFit = false;
              
              for (const p of myCurrentSelections) {
                if (p.PlayerID === player.PlayerID) {
                  const pos = p.Position;
                  if (tempSlotCounts[pos] >= LINEUP[pos].max) continue;
                  if (tempSlotCounts[pos] < LINEUP[pos].main) {
                    tempSlotCounts[pos]++;
                    playerCanFit = true;
                  } else if (FLEX_ELIGIBLE.includes(pos) && tempSlotCounts.FLEX < LINEUP.FLEX.main) {
                    tempSlotCounts.FLEX++;
                    playerCanFit = true;
                  } else if (tempSlotCounts.BENCH < LINEUP.BENCH && tempSlotCounts[pos] < LINEUP[pos].max) {
                    tempSlotCounts.BENCH++;
                    tempSlotCounts[pos]++;
                    playerCanFit = true;
                  }
                  break;
                } else {
                  const pos = p.Position;
                  if (tempSlotCounts[pos] >= LINEUP[pos].max) continue;
                  if (tempSlotCounts[pos] < LINEUP[pos].main) {
                    tempSlotCounts[pos]++;
                  } else if (FLEX_ELIGIBLE.includes(pos) && tempSlotCounts.FLEX < LINEUP.FLEX.main) {
                    tempSlotCounts.FLEX++;
                  } else if (tempSlotCounts.BENCH < LINEUP.BENCH && tempSlotCounts[pos] < LINEUP[pos].max) {
                    tempSlotCounts.BENCH++;
                    tempSlotCounts[pos]++;
                  }
                }
              }
              return playerCanFit;
            }).length;

            return (
              <div style={{ 
                backgroundColor: availableSlots.length === 0 ? '#ffebee' : '#e8f5e8',
                padding: '0.75rem', 
                borderRadius: '4px',
                marginBottom: '1rem',
                border: `1px solid ${availableSlots.length === 0 ? '#f44336' : '#4caf50'}`
              }}>
                <strong>Lineup Status:</strong> {validPlayerCount} valid players selected
                {availableSlots.length > 0 ? (
                  <span style={{ marginLeft: '1rem', color: '#2e7d32' }}>
                    Available: {availableSlots.join(', ')}
                  </span>
                ) : (
                  <span style={{ marginLeft: '1rem', color: '#c62828', fontWeight: 'bold' }}>
                    🔒 LINEUP FULL - No more selections allowed
                  </span>
                )}
                <div style={{ marginTop: '0.5rem', fontSize: '0.9em', color: '#666' }}>
                  <strong>Position Limits:</strong> QB(1-3), RB(2-5), WR(3-6), TE(1-4), K(1-3), DST(1-3), FLEX(1), BENCH(2)
                </div>
              </div>
            );
          })()}
          
          {/* Auto-select button */}
          {isMyTurn && (
            <div style={{ marginBottom: "1rem" }}>
              <button
                onClick={autoSelectPlayer}
                style={{
                  padding: "0.75rem 1.5rem",
                  backgroundColor: "#ff9800",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  marginRight: "1rem",
                  fontSize: "1rem"
                }}
              >
                🤖 Auto-Pick Player
              </button>
              <span style={{ color: "#666", fontSize: "0.9em" }}>
                (Auto-pick uses your preference list FIRST, then falls back to main pool if needed)
              </span>
            </div>
          )}

          {pool.length === 0 ? (
            <div style={{ backgroundColor: '#fff3cd', padding: '1rem', borderRadius: '4px' }}>
              <p>No players available. Please check your backend player pool.</p>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '0.5rem', borderBottom: '1px solid #ccc' }}>Name</th>
                  <th style={{ textAlign: 'left', padding: '0.5rem', borderBottom: '1px solid #ccc' }}>Position</th>
                  <th style={{ textAlign: 'left', padding: '0.5rem', borderBottom: '1px solid #ccc' }}>Status</th>
                  <th style={{ textAlign: 'left', padding: '0.5rem', borderBottom: '1px solid #ccc' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {pool.map(player => {
                  const myCurrentSelections = selections[username] || [];
                  const canFit = canPlayerFit(player.Position, myCurrentSelections); // keep for possible future use, but don't use for disabling
                  const isPreferred = preferred.includes(player.PlayerID);
                  const preferredIndex = preferred.indexOf(player.PlayerID);
                  
                  return (
                    <tr key={player.PlayerID} style={{
                      backgroundColor: isPreferred ? '#e8f5e8' : 'transparent',
                      opacity: 1
                    }}>
                      <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>
                        {isPreferred && <span style={{ color: '#4caf50', fontWeight: 'bold' }}>⭐ </span>}
                        {player.Name}
                        {isPreferred && <span style={{ color: '#666', fontSize: '0.8em' }}> (#{preferredIndex + 1})</span>}
                      </td>
                      <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>
                        <span style={{
                          fontWeight: 'bold',
                          color: 
                            player.Position === 'QB' ? '#1976d2' :
                            player.Position === 'RB' ? '#388e3c' :
                            player.Position === 'WR' ? '#f57c00' :
                            player.Position === 'TE' ? '#7b1fa2' :
                            player.Position === 'K' ? '#d32f2f' :
                            player.Position === 'DST' ? '#5d4037' : '#666'
                        }}>
                          {player.Position}
                        </span>
                      </td>
                      <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>
                        <span style={{
                          color: isPreferred ? '#2e7d32' : '#4caf50',
                          fontWeight: 'bold',
                          fontSize: '0.9em'
                        }}>
                          {isPreferred ? `⭐ Preferred (#${preferredIndex + 1})` : 'Available'}
                        </span>
                      </td>
                      <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>
                        <button
                          onClick={() => selectPlayer(player.PlayerID)}
                          disabled={!isMyTurn}
                          title={!isMyTurn ? 'Not your turn' : 'Select this player'}
                          style={{
                            padding: "0.5rem 1rem",
                            backgroundColor: 
                              !isMyTurn ? "#ccc" :
                              isPreferred ? "#4caf50" : "#2196f3",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                            cursor: !isMyTurn ? "not-allowed" : "pointer",
                            opacity: !isMyTurn ? 0.6 : 1
                          }}
                        >
                          Select
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* --- NEW: Show your team with slot assignment after draft started --- */}
      {gameStarted && (
        (() => {
          // Lineup rules for slot assignment
          const LINEUP = {
            QB: { main: 1, max: 3 },
            RB: { main: 2, max: 5 },
            WR: { main: 3, max: 6 },
            TE: { main: 1, max: 4 },
            K:  { main: 1, max: 3 },
            DST:{ main: 1, max: 3 },
            FLEX: { main: 1, max: 1 },
            BENCH: 2
          };
          const FLEX_ELIGIBLE = ["RB", "WR", "TE"];
          
          // Assign slots to my selections - only include players with valid slots
          const mySelections = selections[username] || [];
          const slotCounts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, FLEX: 0, BENCH: 0 };
          const assigned = [];
          
          for (const player of mySelections) {
            const pos = player.Position;
            
            // Check if position has reached max limit
            if (slotCounts[pos] >= LINEUP[pos].max) {
              console.warn(`Player ${player.player_id || player.PlayerID} cannot be assigned - ${pos} position is at max capacity (${LINEUP[pos].max})`);
              continue; // Skip this player entirely
            }
            
            // Try main position first
            if (slotCounts[pos] < LINEUP[pos].main) {
              slotCounts[pos]++;
              assigned.push({ ...player, slot: "Main" });
              continue;
            }
            
            // Try FLEX if eligible
            if (FLEX_ELIGIBLE.includes(pos) && slotCounts.FLEX < LINEUP.FLEX.main) {
              slotCounts.FLEX++;
              assigned.push({ ...player, slot: "FLEX" });
              continue;
            }
            
            // Try bench (only if bench has space and position isn't at max)
            if (slotCounts.BENCH < LINEUP.BENCH && slotCounts[pos] < LINEUP[pos].max) {
              slotCounts.BENCH++;
              slotCounts[pos]++;
              assigned.push({ ...player, slot: "Bench" });
              continue;
            }
            
            // If we reach here, player cannot be assigned to any valid slot
            console.warn(`Player ${player.player_id || player.PlayerID} cannot be assigned to any valid slot - position ${pos} at max or no bench space`);
            // Don't add this player to assigned array - they will be filtered out
          }

          // Create lineup display structure
          const lineupSlots = {
            QB: { player: null, required: true },
            RB1: { player: null, required: true },
            RB2: { player: null, required: true },
            WR1: { player: null, required: true },
            WR2: { player: null, required: true },
            WR3: { player: null, required: true },
            TE: { player: null, required: true },
            K: { player: null, required: true },
            DST: { player: null, required: true },
            FLEX: { player: null, required: true },
            BENCH1: { player: null, required: false },
            BENCH2: { player: null, required: false }
          };

          // Fill the lineup slots
          let benchCount = 0;
          for (const player of assigned) {
            if (player.slot === "Main") {
              if (player.Position === "QB" && !lineupSlots.QB.player) {
                lineupSlots.QB.player = player;
              } else if (player.Position === "RB" && !lineupSlots.RB1.player) {
                lineupSlots.RB1.player = player;
              } else if (player.Position === "RB" && !lineupSlots.RB2.player) {
                lineupSlots.RB2.player = player;
              } else if (player.Position === "WR" && !lineupSlots.WR1.player) {
                lineupSlots.WR1.player = player;
              } else if (player.Position === "WR" && !lineupSlots.WR2.player) {
                lineupSlots.WR2.player = player;
              } else if (player.Position === "WR" && !lineupSlots.WR3.player) {
                lineupSlots.WR3.player = player;
              } else if (player.Position === "TE" && !lineupSlots.TE.player) {
                lineupSlots.TE.player = player;
              } else if (player.Position === "K" && !lineupSlots.K.player) {
                lineupSlots.K.player = player;
              } else if (player.Position === "DST" && !lineupSlots.DST.player) {
                lineupSlots.DST.player = player;
              }
            } else if (player.slot === "FLEX" && !lineupSlots.FLEX.player) {
              lineupSlots.FLEX.player = player;
            } else if (player.slot === "Bench" && benchCount < 2) {
              if (benchCount === 0) {
                lineupSlots.BENCH1.player = player;
              } else {
                lineupSlots.BENCH2.player = player;
              }
              benchCount++;
            }
          }

          return (
            <div style={{ marginTop: "2rem", padding: "1rem", background: "#f5f5f5", borderRadius: 8 }}>
              <h3>🏈 Your Lineup (QB, RB, WR, TE, K, DST + FLEX + 2 Bench)</h3>
              <div style={{ 
                display: "grid", 
                gridTemplateColumns: "repeat(4, 1fr)", 
                gap: "1rem",
                maxWidth: "1000px",
                margin: "0 auto"
              }}>
                {/* QB */}
                <div style={{
                  backgroundColor: lineupSlots.QB.player ? "#e8f5e8" : "#ffebee",
                  border: `2px solid ${lineupSlots.QB.player ? "#4caf50" : "#f44336"}`,
                  borderRadius: "8px",
                  padding: "1rem",
                  textAlign: "center",
                  minHeight: "80px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center"
                }}>
                  <div style={{ fontWeight: "bold", marginBottom: "0.5rem", color: "#333" }}>QB</div>
                  {lineupSlots.QB.player ? (
                    <div>
                      <div style={{ fontWeight: "bold" }}>{lineupSlots.QB.player.player_id || lineupSlots.QB.player.PlayerID}</div>
                      <div style={{ fontSize: "0.8em", color: "#666" }}>{lineupSlots.QB.player.Position}</div>
                    </div>
                  ) : (
                    <div style={{ color: "#f44336", fontSize: "0.9em" }}>Empty</div>
                  )}
                  </div>

                {/* RB1 */}
                <div style={{
                  backgroundColor: lineupSlots.RB1.player ? "#e8f5e8" : "#ffebee",
                  border: `2px solid ${lineupSlots.RB1.player ? "#4caf50" : "#f44336"}`,
                  borderRadius: "8px",
                  padding: "1rem",
                  textAlign: "center",
                  minHeight: "80px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center"
                }}>
                  <div style={{ fontWeight: "bold", marginBottom: "0.5rem", color: "#333" }}>RB1</div>
                  {lineupSlots.RB1.player ? (
                    <div>
                      <div style={{ fontWeight: "bold" }}>{lineupSlots.RB1.player.player_id || lineupSlots.RB1.player.PlayerID}</div>
                      <div style={{ fontSize: "0.8em", color: "#666" }}>{lineupSlots.RB1.player.Position}</div>
                    </div>
                  ) : (
                    <div style={{ color: "#f44336", fontSize: "0.9em" }}>Empty</div>
                  )}
                </div>

                {/* RB2 */}
                <div style={{
                  backgroundColor: lineupSlots.RB2.player ? "#e8f5e8" : "#ffebee",
                  border: `2px solid ${lineupSlots.RB2.player ? "#4caf50" : "#f44336"}`,
                  borderRadius: "8px",
                  padding: "1rem",
                  textAlign: "center",
                  minHeight: "80px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center"
                }}>
                  <div style={{ fontWeight: "bold", marginBottom: "0.5rem", color: "#333" }}>RB2</div>
                  {lineupSlots.RB2.player ? (
                    <div>
                      <div style={{ fontWeight: "bold" }}>{lineupSlots.RB2.player.player_id || lineupSlots.RB2.player.PlayerID}</div>
                      <div style={{ fontSize: "0.8em", color: "#666" }}>{lineupSlots.RB2.player.Position}</div>
                    </div>
                  ) : (
                    <div style={{ color: "#f44336", fontSize: "0.9em" }}>Empty</div>
                  )}
                </div>

                {/* WR1 */}
                <div style={{
                  backgroundColor: lineupSlots.WR1.player ? "#e8f5e8" : "#ffebee",
                  border: `2px solid ${lineupSlots.WR1.player ? "#4caf50" : "#f44336"}`,
                  borderRadius: "8px",
                  padding: "1rem",
                  textAlign: "center",
                  minHeight: "80px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center"
                }}>
                  <div style={{ fontWeight: "bold", marginBottom: "0.5rem", color: "#333" }}>WR1</div>
                  {lineupSlots.WR1.player ? (
                    <div>
                      <div style={{ fontWeight: "bold" }}>{lineupSlots.WR1.player.player_id || lineupSlots.WR1.player.PlayerID}</div>
                      <div style={{ fontSize: "0.8em", color: "#666" }}>{lineupSlots.WR1.player.Position}</div>
                    </div>
                  ) : (
                    <div style={{ color: "#f44336", fontSize: "0.9em" }}>Empty</div>
                  )}
                </div>

                {/* WR2 */}
                <div style={{
                  backgroundColor: lineupSlots.WR2.player ? "#e8f5e8" : "#ffebee",
                  border: `2px solid ${lineupSlots.WR2.player ? "#4caf50" : "#f44336"}`,
                  borderRadius: "8px",
                  padding: "1rem",
                  textAlign: "center",
                  minHeight: "80px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center"
                }}>
                  <div style={{ fontWeight: "bold", marginBottom: "0.5rem", color: "#333" }}>WR2</div>
                  {lineupSlots.WR2.player ? (
                    <div>
                      <div style={{ fontWeight: "bold" }}>{lineupSlots.WR2.player.player_id || lineupSlots.WR2.player.PlayerID}</div>
                      <div style={{ fontSize: "0.8em", color: "#666" }}>{lineupSlots.WR2.player.Position}</div>
                    </div>
                  ) : (
                    <div style={{ color: "#f44336", fontSize: "0.9em" }}>Empty</div>
                  )}
                </div>

                {/* WR3 */}
                <div style={{
                  backgroundColor: lineupSlots.WR3.player ? "#e8f5e8" : "#ffebee",
                  border: `2px solid ${lineupSlots.WR3.player ? "#4caf50" : "#f44336"}`,
                  borderRadius: "8px",
                  padding: "1rem",
                  textAlign: "center",
                  minHeight: "80px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center"
                }}>
                  <div style={{ fontWeight: "bold", marginBottom: "0.5rem", color: "#333" }}>WR3</div>
                  {lineupSlots.WR3.player ? (
                    <div>
                      <div style={{ fontWeight: "bold" }}>{lineupSlots.WR3.player.player_id || lineupSlots.WR3.player.PlayerID}</div>
                      <div style={{ fontSize: "0.8em", color: "#666" }}>{lineupSlots.WR3.player.Position}</div>
                    </div>
                  ) : (
                    <div style={{ color: "#f44336", fontSize: "0.9em" }}>Empty</div>
                  )}
                </div>

                {/* TE */}
                <div style={{
                  backgroundColor: lineupSlots.TE.player ? "#e8f5e8" : "#ffebee",
                  border: `2px solid ${lineupSlots.TE.player ? "#4caf50" : "#f44336"}`,
                  borderRadius: "8px",
                  padding: "1rem",
                  textAlign: "center",
                  minHeight: "80px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center"
                }}>
                  <div style={{ fontWeight: "bold", marginBottom: "0.5rem", color: "#333" }}>TE</div>
                  {lineupSlots.TE.player ? (
                    <div>
                      <div style={{ fontWeight: "bold" }}>{lineupSlots.TE.player.player_id || lineupSlots.TE.player.PlayerID}</div>
                      <div style={{ fontSize: "0.8em", color: "#666" }}>{lineupSlots.TE.player.Position}</div>
                    </div>
                  ) : (
                    <div style={{ color: "#f44336", fontSize: "0.9em" }}>Empty</div>
                  )}
                </div>

                {/* K */}
                <div style={{
                  backgroundColor: lineupSlots.K.player ? "#e8f5e8" : "#ffebee",
                  border: `2px solid ${lineupSlots.K.player ? "#4caf50" : "#f44336"}`,
                  borderRadius: "8px",
                  padding: "1rem",
                  textAlign: "center",
                  minHeight: "80px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center"
                }}>
                  <div style={{ fontWeight: "bold", marginBottom: "0.5rem", color: "#333" }}>K</div>
                  {lineupSlots.K.player ? (
                    <div>
                      <div style={{ fontWeight: "bold" }}>{lineupSlots.K.player.player_id || lineupSlots.K.player.PlayerID}</div>
                      <div style={{ fontSize: "0.8em", color: "#666" }}>{lineupSlots.K.player.Position}</div>
                    </div>
                  ) : (
                    <div style={{ color: "#f44336", fontSize: "0.9em" }}>Empty</div>
                  )}
                </div>

                {/* DST */}
                <div style={{
                  backgroundColor: lineupSlots.DST.player ? "#e8f5e8" : "#ffebee",
                  border: `2px solid ${lineupSlots.DST.player ? "#4caf50" : "#f44336"}`,
                  borderRadius: "8px",
                  padding: "1rem",
                  textAlign: "center",
                  minHeight: "80px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center"
                }}>
                  <div style={{ fontWeight: "bold", marginBottom: "0.5rem", color: "#333" }}>DST</div>
                  {lineupSlots.DST.player ? (
                    <div>
                      <div style={{ fontWeight: "bold" }}>{lineupSlots.DST.player.player_id || lineupSlots.DST.player.PlayerID}</div>
                      <div style={{ fontSize: "0.8em", color: "#666" }}>{lineupSlots.DST.player.Position}</div>
                    </div>
                  ) : (
                    <div style={{ color: "#f44336", fontSize: "0.9em" }}>Empty</div>
                  )}
                </div>

                {/* FLEX */}
                <div style={{
                  backgroundColor: lineupSlots.FLEX.player ? "#e3f2fd" : "#ffebee",
                  border: `2px solid ${lineupSlots.FLEX.player ? "#2196f3" : "#f44336"}`,
                  borderRadius: "8px",
                  padding: "1rem",
                  textAlign: "center",
                  minHeight: "80px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center"
                }}>
                  <div style={{ fontWeight: "bold", marginBottom: "0.5rem", color: "#333" }}>FLEX</div>
                  {lineupSlots.FLEX.player ? (
                    <div>
                      <div style={{ fontWeight: "bold" }}>{lineupSlots.FLEX.player.player_id || lineupSlots.FLEX.player.PlayerID}</div>
                      <div style={{ fontSize: "0.8em", color: "#666" }}>{lineupSlots.FLEX.player.Position}</div>
                    </div>
                  ) : (
                    <div style={{ color: "#f44336", fontSize: "0.9em" }}>Empty</div>
                  )}
                </div>

                {/* BENCH1 */}
                <div style={{
                  backgroundColor: lineupSlots.BENCH1.player ? "#fff3cd" : "#f5f5f5",
                  border: `2px solid ${lineupSlots.BENCH1.player ? "#ff9800" : "#ccc"}`,
                  borderRadius: "8px",
                  padding: "1rem",
                  textAlign: "center",
                  minHeight: "80px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center"
                }}>
                  <div style={{ fontWeight: "bold", marginBottom: "0.5rem", color: "#333" }}>BENCH1</div>
                  {lineupSlots.BENCH1.player ? (
                    <div>
                      <div style={{ fontWeight: "bold" }}>{lineupSlots.BENCH1.player.player_id || lineupSlots.BENCH1.player.PlayerID}</div>
                      <div style={{ fontSize: "0.8em", color: "#666" }}>{lineupSlots.BENCH1.player.Position}</div>
                    </div>
                  ) : (
                    <div style={{ color: "#999", fontSize: "0.9em" }}>Empty</div>
                  )}
                </div>

                {/* BENCH2 */}
                <div style={{
                  backgroundColor: lineupSlots.BENCH2.player ? "#fff3cd" : "#f5f5f5",
                  border: `2px solid ${lineupSlots.BENCH2.player ? "#ff9800" : "#ccc"}`,
                  borderRadius: "8px",
                  padding: "1rem",
                  textAlign: "center",
                  minHeight: "80px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center"
                }}>
                  <div style={{ fontWeight: "bold", marginBottom: "0.5rem", color: "#333" }}>BENCH2</div>
                  {lineupSlots.BENCH2.player ? (
                    <div>
                      <div style={{ fontWeight: "bold" }}>{lineupSlots.BENCH2.player.player_id || lineupSlots.BENCH2.player.PlayerID}</div>
                      <div style={{ fontSize: "0.8em", color: "#666" }}>{lineupSlots.BENCH2.player.Position}</div>
                    </div>
                  ) : (
                    <div style={{ color: "#999", fontSize: "0.9em" }}>Empty</div>
                  )}
                </div>
              </div>

                  {/* Summary */}
              <div style={{ 
                marginTop: "1rem", 
                padding: "0.75rem", 
                backgroundColor: "#e8f5e8", 
                borderRadius: "4px",
                textAlign: "center"
              }}>
                    <strong>Team Summary:</strong> {assigned.length} valid players
                    <span style={{ marginLeft: "1rem", fontSize: "0.9em", color: "#666" }}>
                      (Main: {assigned.filter(p => p.slot === "Main" || p.slot === "FLEX").length}, 
                      Bench: {assigned.filter(p => p.slot === "Bench").length})
                    </span>
                  </div>
            </div>
          );
        })()
      )}

      {/* Show all users and their preferred players */}
      {/* {users.length > 0 && (
        <div style={{ marginTop: '2rem', padding: '1rem', backgroundColor: '#f5f5f5', borderRadius: '8px' }}>
          <h3>⭐ All Players' Preferences</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '0.5rem' }}>Player</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '0.5rem' }}>Preferred Players (in order)</th>
              </tr>
            </thead>
            <tbody>
              {users.map(user => {
                // Find this user's preferred array from preferredQueue (if available)
                let userPref = [];
                if (typeof preferredQueue === 'object' && preferredQueue !== null) {
                  if (user.id && preferredQueue[user.id]) {
                    userPref = preferredQueue[user.id];
                  } else if (preferredQueue[user.username]) {
                    userPref = preferredQueue[user.username];
                  }
                }
                // Get player details for each preferred PlayerID
                const details = (Array.isArray(userPref) ? userPref : []).map((pid, idx) => {
                  const p = pool.find(pl => pl.PlayerID === pid);
                  if (!p) return null;
                  return (
                    <span key={pid} style={{
                      display: 'inline-block',
                      backgroundColor: idx < 5 ? '#e3f2fd' : '#fffde7',
                      color: '#333',
                      borderRadius: '4px',
                      padding: '0.25rem 0.5rem',
                      marginRight: '0.25rem',
                      marginBottom: '0.25rem',
                      border: '1px solid #ccc',
                      fontSize: '0.95em'
                    }}>
                      {idx + 1}. {p.Name} ({p.Position}) {idx < 5 ? 'Main' : 'Bench'}
                    </span>
                  );
                }).filter(Boolean);
                return (
                  <tr key={user.username}>
                    <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>{user.username}</td>
                    <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>{details.length > 0 ? details : <span style={{ color: '#aaa' }}>No preferences</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )} */}

      {/* Show each user's team - only valid slotted players */}
      {Object.entries(selections).map(([user, team]) => {
        // Filter to only show players that would get valid slots
        const LINEUP = {
          QB: { main: 1, max: 3 },
          RB: { main: 2, max: 5 },
          WR: { main: 3, max: 6 },
          TE: { main: 1, max: 4 },
          K:  { main: 1, max: 3 },
          DST:{ main: 1, max: 3 },
          FLEX: { main: 1, max: 1 },
          BENCH: 2
        };
        const FLEX_ELIGIBLE = ["RB", "WR", "TE"];
        const slotCounts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, FLEX: 0, BENCH: 0 };
        const validPlayers = [];
        
        for (const player of team) {
          const pos = player.Position;
          
          // Check if position has reached max limit
          if (slotCounts[pos] >= LINEUP[pos].max) {
            continue; // Skip this player
          }
          
          // Try to assign to a valid slot
          if (slotCounts[pos] < LINEUP[pos].main) {
            slotCounts[pos]++;
            validPlayers.push({ ...player, slot: "Main" });
          } else if (FLEX_ELIGIBLE.includes(pos) && slotCounts.FLEX < LINEUP.FLEX.main) {
            slotCounts.FLEX++;
            validPlayers.push({ ...player, slot: "FLEX" });
          } else if (slotCounts.BENCH < LINEUP.BENCH && slotCounts[pos] < LINEUP[pos].max) {
            slotCounts.BENCH++;
            slotCounts[pos]++;
            validPlayers.push({ ...player, slot: "Bench" });
          }
          // If none of the above, player is not included in valid players
        }

        return (
          <div key={user} style={{ marginBottom: "1rem", padding: "1rem", backgroundColor: "#f9f9f9", borderRadius: "4px" }}>
            <h4>{user}'s Team ({validPlayers.length} valid players)</h4>
            {validPlayers.length === 0 ? (
              <p style={{ color: "#888", fontStyle: "italic" }}>No valid players yet</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: "1.5rem" }}>
                {validPlayers.map(player => (
                  <li key={player.PlayerID} style={{ marginBottom: "0.25rem" }}>
                    <span style={{ fontWeight: "bold" }}>{player.player_id || player.PlayerID}</span> - {player.Position}
                    <span style={{ 
                      marginLeft: "0.5rem", 
                      fontSize: "0.8em", 
                      color: 
                        player.slot === "Main" ? "#2e7d32" :
                        player.slot === "FLEX" ? "#1976d2" :
                        "#f57c00",
                      fontWeight: "bold" 
                    }}>
                      ({player.slot === "FLEX" ? "FLEX" : player.slot})
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      
      {/* Toastify Container for notifications */}
      <ToastContainer
        position="top-right"
        autoClose={5000}
        hideProgressBar={false}
        newestOnTop={false}
        closeOnClick
        rtl={false}
        pauseOnFocusLoss
        draggable
        pauseOnHover
        theme="light"
      />
    </div>
  );
};

export default App;