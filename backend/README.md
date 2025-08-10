# SFS Draft Room

A simple dockerized Express.js Node.js application that connects to managed PostgreSQL and Redis services.

## Prerequisites

- Managed PostgreSQL database (e.g., AWS RDS, Google Cloud SQL, etc.)
- Managed Redis service (e.g., AWS ElastiCache, Redis Cloud, etc.)

## Setup

1. **Configure environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your managed database and Redis credentials
   ```

2. **Build and run with Docker:**
   ```bash
   docker-compose up --build
   ```

3. **Access the application:**
   - API: http://localhost:3000

## Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure .env file with your managed services:**
   - Update `DB_HOST`, `DB_USER`, `DB_PASSWORD` for your managed PostgreSQL
   - Update `REDIS_HOST`, `REDIS_PASSWORD` for your managed Redis

3. **Start development server:**
   ```bash
   npm run dev
   ```

## Dependencies

- Express.js
- Socket.io
- PostgreSQL (pg) - connects to managed PostgreSQL
- Redis - connects to managed Redis
- BullMQ
- node-cron

## Environment Variables

See `.env` file for required environment variables:
- Database connection details for your managed PostgreSQL
- Redis connection details for your managed Redis service
