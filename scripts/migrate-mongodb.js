const fs = require("node:fs");
const path = require("node:path");
const { MongoClient } = require("mongodb");
require("dotenv").config();

const sourcePath = path.join(__dirname, "..", "data", "store.json");
const templatePath = path.join(__dirname, "..", "data", "store.example.json");

function readStore() {
  const filePath = fs.existsSync(sourcePath) ? sourcePath : templatePath;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function migrate() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI must be configured before running the migration");
  }

  const store = readStore();
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });

  await client.connect();
  try {
    const database = client.db(process.env.MONGODB_DB || "careerlink");
    await database.collection("app_meta").replaceOne(
      { _id: "store" },
      { _id: "store", ...store.meta, migratedAt: new Date().toISOString() },
      { upsert: true },
    );

    const collections = [
      ["users", store.users || []],
      ["jobs", store.jobs || []],
      ["trends", store.trends || []],
      ["degrees", store.degrees || []],
    ];

    for (const [name, records] of collections) {
      const collection = database.collection(name);
      for (const record of records) {
        if (!record.id) {
          continue;
        }
        await collection.replaceOne({ id: record.id }, record, { upsert: true });
      }
    }

    console.log(JSON.stringify({ ok: true, database: database.databaseName, users: store.users?.length || 0, jobs: store.jobs?.length || 0, trends: store.trends?.length || 0, degrees: store.degrees?.length || 0 }));
  } finally {
    await client.close();
  }
}

migrate().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
