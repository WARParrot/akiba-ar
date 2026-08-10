import { createApp } from './app.js';
import { migrate, pool } from './db.js';

const port = Number(process.env.PORT ?? 3100);
await migrate();
createApp(pool).listen(port, () => {
  console.log(`akiba-ar server on :${port} (onsite=${process.env.LOCAL_SERVER === '1'})`);
});
