# Polymarket Backend - Development Plan

## Overview
Backend system untuk scraping news, mendeteksi trend, dan auto-generate Polymarket-style prediction questions menggunakan AI (OpenAI).

## Tech Stack

| Concern | Library |
|---|---|
| Runtime | Bun |
| Language | TypeScript |
| HTTP Server | Hono |
| WebSocket | Bun native WebSocket |
| Scraping | cheerio + rss-parser |
| HTTP Client | Bun native fetch |
| Database | PostgreSQL via Drizzle ORM + postgres (pg driver) |
| AI/LLM | OpenAI API (GPT-4o) |
| Scheduler | node-cron |

## Project Structure

```
src/
├── scrapers/                   # News scraping modules
│   ├── newsapi.ts              # NewsAPI.org scraper
│   ├── rss.ts                  # RSS feed parser (Google News, Reuters, AP)
│   └── polymarket.ts           # Polymarket existing markets reference
├── processors/                 # Data processing
│   ├── cleaner.ts              # Deduplicate & clean articles
│   ├── extractor.ts            # Entity extraction
│   └── categorizer.ts          # Topic categorization
├── ai/                         # AI/LLM layer
│   ├── trend.ts                # Trend detection logic
│   ├── sentiment.ts            # Sentiment analysis
│   └── question-generator.ts   # Generate Polymarket-style questions
├── db/                         # Database
│   ├── schema.ts               # Drizzle table definitions
│   ├── index.ts                # DB connection
│   └── migrate.ts              # Migration runner
├── api/                        # REST API routes
│   └── routes.ts
├── ws/                         # WebSocket handlers
│   └── handler.ts
├── jobs/                       # Scheduled tasks
│   └── scheduler.ts            # Cron jobs for scraping
└── config.ts                   # API keys, env settings
```

## Database Schema

### articles
| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | Auto increment |
| title | TEXT | Judul berita |
| description | TEXT | Ringkasan/deskripsi |
| content | TEXT | Konten lengkap (jika ada) |
| url | TEXT UNIQUE | URL artikel (untuk dedup) |
| source | VARCHAR(100) | Sumber (newsapi, google_rss, reuters, dll) |
| category | VARCHAR(50) | Kategori (politics, economy, crypto, dll) |
| published_at | TIMESTAMP | Waktu publish |
| scraped_at | TIMESTAMP | Waktu di-scrape |
| sentiment | VARCHAR(20) | positive / negative / neutral |
| sentiment_score | DECIMAL | Score -1.0 to 1.0 |

### trends
| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | Auto increment |
| topic | VARCHAR(200) | Topik trending |
| mention_count | INT | Jumlah mention dalam articles |
| category | VARCHAR(50) | Kategori |
| first_seen | TIMESTAMP | Pertama kali muncul |
| last_seen | TIMESTAMP | Terakhir muncul |
| trend_score | DECIMAL | Skor trending (frequency + recency) |

### generated_questions
| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | Auto increment |
| question | TEXT | Pertanyaan gaya Polymarket |
| description | TEXT | Deskripsi/konteks pertanyaan |
| category | VARCHAR(50) | Kategori |
| source_article_ids | INT[] | Artikel sumber referensi |
| resolution_date | TIMESTAMP | Perkiraan tanggal resolusi |
| created_at | TIMESTAMP | Waktu generate |
| ai_model | VARCHAR(50) | Model AI yang dipakai |
| confidence_score | DECIMAL | AI confidence score |
| status | VARCHAR(20) | draft / published / resolved |

## API Endpoints

### REST API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/news` | List scraped articles (paginated, filterable) |
| GET | `/api/news/:id` | Detail satu article |
| GET | `/api/trends` | List trending topics |
| GET | `/api/trends/:topic` | Detail trend + related articles |
| GET | `/api/questions` | List generated questions |
| GET | `/api/questions/:id` | Detail question + source articles |
| POST | `/api/scrape/trigger` | Manual trigger scraping |
| POST | `/api/questions/generate` | Manual trigger question generation |

### WebSocket

| Event | Direction | Description |
|---|---|---|
| `news:new` | Server → Client | Artikel baru di-scrape |
| `trend:update` | Server → Client | Trend score berubah |
| `question:new` | Server → Client | Question baru di-generate |
| `subscribe` | Client → Server | Subscribe ke kategori tertentu |

## News Sources

| Source | Method | Prioritas |
|---|---|---|
| NewsAPI.org | REST API | High - headlines global |
| Google News RSS | RSS Feed | High - trending, gratis |
| Reuters RSS | RSS Feed | Medium - breaking news |
| AP News RSS | RSS Feed | Medium - world news |
| Polymarket API | REST API | Low - referensi existing markets |

## Development Phases

### Phase 1 - Foundation ✅ (Current)
- [x] Setup project structure
- [x] Install dependencies
- [x] Setup PostgreSQL schema dengan Drizzle ORM
- [x] Build RSS scraper (Google News)
- [x] Build NewsAPI scraper
- [x] Basic article storage

### Phase 2 - AI Layer
- [ ] Integrate OpenAI API
- [ ] Implement question generator (Polymarket-style)
- [ ] Implement trend detection
- [ ] Implement sentiment analysis
- [ ] Implement article categorization

### Phase 3 - REST API
- [ ] Setup Hono server
- [ ] Implement all REST endpoints
- [ ] Add pagination & filtering
- [ ] Error handling & validation

### Phase 4 - WebSocket
- [ ] Setup Bun WebSocket server
- [ ] Implement real-time push events
- [ ] Subscription system per category

### Phase 5 - Automation
- [ ] Setup cron scheduler
- [ ] Auto-scrape every 15-30 menit
- [ ] Auto-generate questions dari trending topics
- [ ] Auto-update trend scores

### Phase 6 - Polish
- [ ] Rate limiting
- [ ] Logging & monitoring
- [ ] API documentation (Swagger/OpenAPI spec)
- [ ] Docker setup
- [ ] Environment configuration

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/polymarket

# APIs
NEWSAPI_KEY=your_newsapi_key
OPENAI_API_KEY=your_openai_api_key

# Server
PORT=3000
WS_PORT=3001

# Scraping
SCRAPE_INTERVAL_MINUTES=15
```

## Contoh Output Question Generator

Input berita: *"Trump threatens new tariffs on China amid trade war escalation"*

Output:
- **"Will Trump impose new tariffs on China before July 2026?"**
- **"Will China retaliate with counter-tariffs by Q3 2026?"**
- **"Will US-China trade volume decrease by 10%+ in 2026?"**

Setiap question di-generate dengan:
- `resolution_date` (kapan bisa di-resolve)
- `confidence_score` (seberapa yakin AI ini jadi pertanyaan bagus)
- `category` auto-assigned
- `source_article_ids` linked ke artikel sumber
