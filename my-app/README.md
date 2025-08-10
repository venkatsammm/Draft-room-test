# NFL Fantasy Draft Frontend

This is a comprehensive frontend application for testing and using the NFL Fantasy Draft backend. The frontend includes both the main draft application and backend testing capabilities.

## Features

### 🏈 Main Draft Application
- **Real-time Fantasy Draft**: Join or create draft rooms with real-time player selection
- **Lineup Configuration**: Supports the full fantasy football lineup format (QB, RB, WR, TE, FLEX, K, DST)
- **Player Preferences**: Set preferred players before the draft starts
- **Turn-based Selection**: 45-second timer per pick with auto-pick functionality
- **Multi-round Draft**: 16 rounds with 9 starters + 7 bench players
- **Real-time Updates**: Live updates for all players in the room

### 🔧 Backend Testing Panel
- **Connection Testing**: Verify backend connectivity
- **API Endpoint Testing**: Test all backend endpoints
- **Lineup Configuration**: View and test lineup settings
- **Room Management**: Create and manage draft rooms
- **Player Pool**: Test player data retrieval
- **Real-time Status**: Monitor backend health and status

## Getting Started

### Prerequisites
- Node.js (v14 or higher)
- Backend server running on `http://localhost:8000`

### Installation

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm start
```

3. Open [http://localhost:3001](http://localhost:3001) in your browser

### Backend Setup

Make sure your backend server is running:

```bash
cd ../backend
npm install
npm start
```

The backend should be running on `http://localhost:8000`

## Usage

### Testing Backend Functionality

1. **Backend Testing Panel**: The main page includes a testing panel at the top
   - Click "Test Connection" to verify backend connectivity
   - Click "Get Lineup Config" to test lineup configuration
   - Click "Get All Rooms" to see active rooms
   - All tests show detailed results and response data

2. **API Testing**: Use the testing panel to verify:
   - Backend connection status
   - Lineup configuration retrieval
   - Room creation and management
   - Player pool data
   - Real-time socket connections

### Using the Draft Application

1. **Create or Join Room**:
   - Enter your username
   - Create a new room or join an existing one using a room ID

2. **Set Preferences**:
   - Select your preferred players in order of preference
   - Submit preferences to participate in the draft

3. **Start Draft** (Host only):
   - Host can start the draft when all players have submitted preferences
   - Minimum 2 players required to start

4. **Draft Players**:
   - Take turns selecting players from the available pool
   - 45-second timer per pick
   - Auto-pick enabled for timeouts

5. **View Results**:
   - See final teams after draft completion
   - View all players' preferences and selections

## Backend API Endpoints Tested

- `GET /` - Backend status and health check
- `GET /api/lineup-config` - Fantasy football lineup configuration
- `GET /api/players` - Player pool data
- `GET /api/rooms` - List all active rooms
- `POST /api/create-room` - Create new draft room
- `GET /api/room/:roomId` - Get specific room information

## Socket.IO Events

The frontend handles these real-time events:
- `draft-state` - Current draft state updates
- `draft-started` - Draft initialization
- `turn-update` - Turn changes and timer updates
- `player-selected` - Player selection events
- `draft-completed` - Draft completion
- `preferred-players-updated` - Preference submission confirmations

## Error Handling

The frontend includes comprehensive error handling:
- Connection failures
- API endpoint errors
- Socket.IO disconnections
- Invalid room IDs or usernames
- Draft rule violations

## Troubleshooting

### Common Issues

1. **Backend Connection Failed**:
   - Ensure backend is running on port 8000
   - Check firewall settings
   - Verify CORS configuration

2. **Socket Connection Issues**:
   - Check WebSocket transport settings
   - Verify backend socket.io setup
   - Check browser console for errors

3. **Player Pool Empty**:
   - Verify PlayerDetails.json exists in backend
   - Check backend logs for player loading errors

4. **Draft Not Starting**:
   - Ensure all players have submitted preferences
   - Check minimum player requirement (2 players)
   - Verify host permissions

### Debug Information

The frontend provides detailed logging:
- Console logs for all socket events
- API response data in testing panel
- Real-time connection status
- Error messages with context

## Development

### Project Structure
```
src/
├── App.jsx              # Main application component
├── BackendTester.jsx    # Backend testing component
├── index.js             # Application entry point
└── index.css            # Global styles
```

### Key Components

- **App.jsx**: Main draft application with real-time functionality
- **Backend Testing Panel**: Integrated testing interface
- **Socket.IO Integration**: Real-time communication with backend
- **Error Handling**: Comprehensive error management
- **Responsive Design**: Works on desktop and mobile

## Contributing

1. Test backend connectivity before making changes
2. Use the testing panel to verify API endpoints
3. Check console logs for debugging information
4. Ensure socket events are properly handled
5. Test with multiple users in a room

## License

This project is part of the NFL Fantasy Draft application.
