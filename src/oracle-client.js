const oracledb = require('oracledb');
const logger = require('./logger');

class OracleClient {
  constructor(config) {
    this.config = config;
    this.pool = null;
  }

  async connect() {
    try {
      logger.info('Connecting to Oracle database...');

      this.pool = await oracledb.createPool({
        user: this.config.user,
        password: this.config.password,
        connectString: this.config.sid
          ? `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${this.config.host})(PORT=${this.config.port}))(CONNECT_DATA=(SID=${this.config.sid})))`
          : `${this.config.host}:${this.config.port}/${this.config.service}`,
        poolMin: 1,
        poolMax: 4
      });

      // Test with a simple query
      const conn = await this.pool.getConnection();
      const result = await conn.execute('SELECT 1 FROM DUAL');
      await conn.close();

      logger.info('Connected to Oracle database');
      return true;
    } catch (err) {
      logger.error('Failed to connect to Oracle:', err);
      throw err;
    }
  }

  async query(sql, params = [], options = {}) {
    if (!this.pool) {
      await this.connect();
    }

    const conn = await this.pool.getConnection();
    try {
      const result = await conn.execute(sql, params, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        ...options
      });
      return result.rows;
    } finally {
      await conn.close();
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.close(0);
      this.pool = null;
      logger.info('Oracle connection pool closed');
    }
  }
}

module.exports = OracleClient;
