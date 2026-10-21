const fs = require("node:fs");
const path = require("node:path");
const { MongoClient } = require("mongodb");
require("dotenv").config();

async function backup() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI must be configured before running the backup");
  }

  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  await client.connect();

  try {
    const database = client.db(process.env.MONGODB_DB || "careerlink");
    const names = ["app_meta", "users", "jobs", "trends", "degrees", "app_state"];
    const collections = {};
    for (const name of names) {
      collections[name] = await database.collection(name).find({}).toArray();
    }

    const backupDirectory = path.join(__dirname, "..", "backups");
    fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = path.join(backupDirectory, `mongodb-${timestamp}.json`);
    fs.writeFileSync(outputPath, JSON.stringify({ database: database.databaseName, createdAt: new Date().toISOString(), collections }, null, 2), { encoding: "utf8", mode: 0o600 });
    console.log(`Backup written to ${outputPath}`);
  } finally {
    await client.close();
  }
}

backup().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
