import express, { Request, Response } from 'express';
import { register } from 'prom-client';
import { initializeJobs } from './api/jobs';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// Initialize background jobs (DLQ metrics sampling)
initializeJobs();

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'talenttrust-backend' });
});

app.get('/api/v1/contracts', (_req: Request, res: Response) => {
  res.json({ contracts: [] });
});

// Prometheus metrics endpoint
app.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  console.log(`TalentTrust API listening on http://localhost:${PORT}`);
});
