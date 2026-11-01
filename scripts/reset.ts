import { db } from '../src/db';
import { resetSchema } from '../src/schema';

resetSchema(db)
  .then(() => db.end())
  .catch(async (e) => {
    console.error(e);
    await db.end();
    process.exit(1);
  });
