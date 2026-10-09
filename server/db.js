const { Pool } = require("pg");

const CONN = process.env.DATABASE_URL || "postgresql://devteam:D3vteaM%2321@172.16.1.30:5432/VMP-POC";

const pool = new Pool({ connectionString: CONN, max: 10 });

module.exports = { pool };
