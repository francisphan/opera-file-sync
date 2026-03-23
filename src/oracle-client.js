const oracledb = require('oracledb');
const logger = require('./logger');

class OracleClient {
  constructor(config) {
    this.config = config;
    this.pool = null;
  }

  async connect() {
    // Close any existing broken pool before reconnecting
    if (this.pool) {
      try { await this.pool.close(0); } catch (_) { /* ignore */ }
      this.pool = null;
    }

    try {
      logger.info('Connecting to Oracle database...');

      this.pool = await oracledb.createPool({
        user: this.config.user,
        password: this.config.password,
        connectString: this.config.sid
          ? `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${this.config.host})(PORT=${this.config.port}))(CONNECT_DATA=(SID=${this.config.sid})))`
          : `${this.config.host}:${this.config.port}/${this.config.service}`,
        poolMin: 1,
        poolMax: 4,
        poolPingInterval: 60,       // ping idle connections every 60s to detect dead ones
        queueTimeout: 30000         // fail after 30s if no connection available (prevents deadlock)
      });

      // Test with a simple query (release connection even on failure)
      let conn;
      try {
        conn = await this.pool.getConnection();
        await conn.execute('SELECT 1 FROM DUAL');
      } finally {
        if (conn) {
          try { await conn.close(); } catch (_) { /* ignore close errors */ }
        }
      }

      logger.info('Connected to Oracle database');
      return true;
    } catch (err) {
      logger.error('Failed to connect to Oracle:', err);
      this.pool = null;
      throw err;
    }
  }

  async query(sql, params = [], options = {}) {
    if (!this.pool) {
      await this.connect();
    }

    let conn;
    try {
      conn = await this.pool.getConnection();
      const result = await conn.execute(sql, params, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        ...options
      });
      return result.rows;
    } catch (err) {
      // Detect fatal connection errors and invalidate pool for reconnect on next call
      const oraCode = err.errorNum || 0;
      if (oraCode === 3113 || oraCode === 3114 || oraCode === 12537 || oraCode === 12541 || oraCode === 28) {
        logger.warn(`Oracle connection lost (ORA-${oraCode}), will reconnect on next query`);
        try { await this.pool.close(0); } catch (_) { /* ignore */ }
        this.pool = null;
      }
      throw err;
    } finally {
      if (conn) {
        try { await conn.close(); } catch (_) { /* ignore close errors on dead connections */ }
      }
    }
  }

  async close() {
    if (this.pool) {
      try {
        await this.pool.close(0);
      } catch (err) {
        logger.warn('Error closing Oracle pool:', err.message);
      }
      this.pool = null;
      logger.info('Oracle connection pool closed');
    }
  }
}

module.exports = OracleClient;
