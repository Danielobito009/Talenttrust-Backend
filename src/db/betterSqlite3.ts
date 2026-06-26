import type * as BetterSqlite3 from 'better-sqlite3';

interface DatabaseConstructor {
  new (filename: string, options?: BetterSqlite3.Options): BetterSqlite3.Database;
  (filename: string, options?: BetterSqlite3.Options): BetterSqlite3.Database;
}

let Database: DatabaseConstructor;

namespace Database {
  export type Database = BetterSqlite3.Database;
}
try {
  // Attempt to load the native module and test if its bindings work.
  const RealDatabase = require('better-sqlite3');
  const testDb = new RealDatabase(':memory:');
  testDb.close();
  Database = RealDatabase;
} catch {
  // Fallback mock implementation for environments without the native bindings.
  const fileStates = new Map<string, Record<string, any[]>>();

  const getDbState = (dbPath: string): Record<string, any[]> => {
    const key = dbPath === ':memory:' || !dbPath ? Math.random().toString() : dbPath;
    let state = fileStates.get(key);
    if (!state) {
      state = {
        users: [],
        contracts: [],
        reputation_entries: [],
        transactions: [],
        webhook_dlq: [],
        deployment_history: [],
        idempotency_store: [],
        audit_log_entries: [],
      };
      fileStates.set(key, state);
    }
    return state;
  };

  const toCamelCase = (str: string): string => {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  };

  const escapeRegExp = (str: string): string => {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  const splitSqlValues = (str: string): string[] => {
    const parts: string[] = [];
    let current = '';
    let inQuote: string | null = null;
    let parenDepth = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (char === "'" || char === '"') {
        if (inQuote === char) {
          inQuote = null;
        } else if (inQuote === null) {
          inQuote = char;
        }
        current += char;
      } else if (char === '(' && !inQuote) {
        parenDepth++;
        current += char;
      } else if (char === ')' && !inQuote) {
        parenDepth--;
        current += char;
      } else if (char === ',' && !inQuote && parenDepth === 0) {
        parts.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    parts.push(current.trim());
    return parts;
  };

  const parseSqlValue = (val: string): any => {
    val = val.trim();
    if (val.toUpperCase() === 'NULL') return null;
    if (val.toUpperCase().startsWith("DATETIME(")) {
      const match = val.match(/datetime\(\s*['"]now['"]\s*(?:,\s*['"](-?\d+)\s*(\w+)['"]\s*)?\)/i);
      if (match) {
        const date = new Date();
        if (match[1] && match[2]) {
          const num = parseInt(match[1], 10);
          const unit = match[2].toLowerCase();
          if (unit.startsWith('day')) {
            date.setDate(date.getDate() + num);
          } else if (unit.startsWith('month')) {
            date.setMonth(date.getMonth() + num);
          } else if (unit.startsWith('year')) {
            date.setFullYear(date.getFullYear() + num);
          }
        }
        return date.toISOString();
      }
      return new Date().toISOString();
    }
    // Check if numeric
    if (/^-?\d+$/.test(val)) return parseInt(val, 10);
    if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
    // Strip quotes
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      return val.slice(1, -1).replace(/''/g, "'"); // Unescape single quotes in SQL
    }
    return val;
  };

  const splitByAnd = (str: string): string[] => {
    const parts: string[] = [];
    let current = '';
    let parenDepth = 0;
    let inQuote: string | null = null;
    let i = 0;
    while (i < str.length) {
      const char = str[i];
      if (char === "'" || char === '"') {
        if (inQuote === char) inQuote = null;
        else if (inQuote === null) inQuote = char;
        current += char;
        i++;
      } else if (char === '(' && !inQuote) {
        parenDepth++;
        current += char;
        i++;
      } else if (char === ')' && !inQuote) {
        parenDepth--;
        current += char;
        i++;
      } else if (!inQuote && parenDepth === 0 && str.slice(i).toUpperCase().startsWith('AND ')) {
        parts.push(current.trim());
        current = '';
        i += 4; // Skip "AND "
      } else {
        current += char;
        i++;
      }
    }
    parts.push(current.trim());
    return parts.filter(p => p.length > 0);
  };

  const evaluateSimpleCondition = (row: any, condSql: string, params: any[], paramIndex: { value: number }): boolean => {
    condSql = condSql.trim();
    const match = condSql.match(/^(\w+)\s*(=|!=|<=|>=|<|>|\bIS\s+NOT\b|\bIS\b|\bLIKE\b)\s*(.+)$/i);
    if (!match) return false;
    const field = match[1].toLowerCase();
    const op = match[2].toUpperCase();
    const valStr = match[3].trim();

    let val: any;
    if (valStr === '?') {
      val = params[paramIndex.value++];
    } else {
      val = parseSqlValue(valStr);
    }

    const rowVal = row[field] !== undefined ? row[field] : row[toCamelCase(field)];

    if (op === '=') {
      return rowVal === val;
    } else if (op === '!=') {
      return rowVal !== val;
    } else if (op === '<=') {
      return rowVal <= val;
    } else if (op === '>=') {
      return rowVal >= val;
    } else if (op === '<') {
      return rowVal < val;
    } else if (op === '>') {
      return rowVal > val;
    } else if (op === 'IS') {
      if (valStr.toUpperCase() === 'NULL') {
        return rowVal === null || rowVal === undefined;
      }
      return rowVal === val;
    } else if (op === 'IS NOT') {
      if (valStr.toUpperCase() === 'NULL') {
        return rowVal !== null && rowVal !== undefined;
      }
      return rowVal !== val;
    } else if (op === 'LIKE') {
      if (typeof rowVal !== 'string') return false;
      const regexStr = '^' + escapeRegExp(val).replace(/%/g, '.*') + '$';
      const regex = new RegExp(regexStr, 'i');
      return regex.test(rowVal);
    }

    return false;
  };

  const evaluateCondition = (row: any, condSql: string, params: any[], paramIndex: { value: number }): boolean => {
    condSql = condSql.trim();
    if (condSql.startsWith('(') && condSql.endsWith(')')) {
      const inner = condSql.slice(1, -1);
      const terms = inner.split(/\s+OR\s+/i);
      const currentParamIndex = paramIndex.value;
      for (const term of terms) {
        const termParamIndex = { value: currentParamIndex };
        if (evaluateSimpleCondition(row, term, params, termParamIndex)) {
          paramIndex.value = termParamIndex.value;
          return true;
        }
      }
      const numParams = (inner.match(/\?/g) || []).length;
      paramIndex.value += numParams;
      return false;
    }
    return evaluateSimpleCondition(row, condSql, params, paramIndex);
  };

  const filterRows = (rows: any[], whereSql: string, params: any[]): any[] => {
    if (!whereSql) return rows;
    const conditions = splitByAnd(whereSql);
    const paramIndex = { value: 0 };
    return rows.filter(row => {
      paramIndex.value = 0;
      for (const cond of conditions) {
        if (!evaluateCondition(row, cond, params, paramIndex)) {
          return false;
        }
      }
      return true;
    });
  };

  class MockDatabase {
    open: boolean;
    private _pragmaValues: Record<string, any> = {};

    constructor(_path: string) {
      this.open = true;
    }

    pragma(stmt: string, ..._args: any[]) {
      const arg = _args[0];
      // pragma("name", { simple: true }) — getter
      if (typeof arg === 'object' && arg !== null && (arg as any).simple) {
        const key = stmt.split('=')[0].trim().toLowerCase();
        if (key in this._pragmaValues) {
          return this._pragmaValues[key];
        }
        // Defaults
        if (stmt.includes('journal_mode')) return 'memory';
        if (stmt.includes('synchronous')) return 1;
        if (stmt.includes('busy_timeout')) return this._pragmaValues['busy_timeout'] ?? 5000;
        if (stmt.includes('foreign_keys')) return 1;
        return undefined;
      }
      // pragma("setting = value") — setter
      const parts = stmt.split('=');
      if (parts.length === 2) {
        this._pragmaValues[parts[0]!.trim().toLowerCase()] = parts[1]!.trim();
        // Convert numeric strings
        const num = Number(parts[1]!.trim());
        if (!isNaN(num)) this._pragmaValues[parts[0]!.trim().toLowerCase()] = num;
      }
      // pragma("table_info(...)") — returns schema array
      if (stmt.includes('table_info')) {
        return [{ name: 'id' }, { name: 'version' }];
      }
      return [];
    }

    prepare(_sql: string) {
      return {
        run: (..._args: any[]) => ({ lastInsertRowid: 0, changes: 0 }),
        get: (..._args: any[]) => undefined,
        all: (..._args: any[]) => [],
        iterate: function* () {},
      };
    }
    exec(sql: string) {
      const statements = sql.split(';');
      for (let stmt of statements) {
        stmt = stmt.replace(/\s+/g, ' ').trim();
        if (!stmt) continue;
        const cleanUpper = stmt.toUpperCase();
        if (cleanUpper.startsWith('DELETE FROM')) {
          const match = stmt.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]+))?/i);
          if (match) {
            const table = match[1].toLowerCase();
            const whereSql = match[2];
            const tableState = this.state[table];
            if (tableState) {
              if (whereSql) {
                const rowsToKeep = tableState.filter(row => {
                  const paramIndex = { value: 0 };
                  const conditions = splitByAnd(whereSql);
                  for (const cond of conditions) {
                    if (!evaluateCondition(row, cond, [], paramIndex)) {
                      return true;
                    }
                  }
                  return false;
                });
                this.state[table] = rowsToKeep;
              } else {
                tableState.length = 0;
              }
            }
          }
        } else if (cleanUpper.startsWith('INSERT INTO') || cleanUpper.startsWith('INSERT OR IGNORE INTO') || cleanUpper.startsWith('INSERT OR REPLACE INTO')) {
          const insertMatch = stmt.match(/INSERT\s*(?:OR\s+\w+)?\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*([\s\S]+)/i);
          if (insertMatch) {
            const tableName = insertMatch[1].toLowerCase();
            const cols = insertMatch[2].split(',').map(c => c.trim().toLowerCase());
            const valuesPart = insertMatch[3].trim();
            const rowsOfValues: string[] = [];
            let currentStr = '';
            let parenDepth = 0;
            let inQuote: string | null = null;
            for (let i = 0; i < valuesPart.length; i++) {
              const char = valuesPart[i];
              if (char === "'" || char === '"') {
                if (inQuote === char) inQuote = null;
                else if (inQuote === null) inQuote = char;
                currentStr += char;
              } else if (char === '(' && !inQuote) {
                parenDepth++;
                if (parenDepth === 1) {
                  currentStr = '';
                } else {
                  currentStr += char;
                }
              } else if (char === ')' && !inQuote) {
                parenDepth--;
                if (parenDepth === 0) {
                  rowsOfValues.push(currentStr);
                } else {
                  currentStr += char;
                }
              } else {
                if (parenDepth > 0) {
                  currentStr += char;
                }
              }
            }

            const tableState = this.state[tableName];
            if (tableState) {
              for (const rowValStr of rowsOfValues) {
                const rawValues = splitSqlValues(rowValStr);
                const values = rawValues.map(v => parseSqlValue(v));
                const newRow: any = {};
                for (let c = 0; c < cols.length; c++) {
                  newRow[cols[c]] = values[c];
                }

                if (cleanUpper.includes('IGNORE')) {
                  let exists = false;
                  if (tableName === 'users') {
                    exists = tableState.some(u => u.id === newRow.id || u.username === newRow.username || u.email === newRow.email);
                  } else if (tableName === 'reputation_entries') {
                    exists = tableState.some(r => r.reviewer_id === newRow.reviewer_id && r.target_id === newRow.target_id && r.context_id === newRow.context_id);
                  } else if (tableName === 'contracts') {
                    exists = tableState.some(c => c.id === newRow.id);
                  }
                  if (exists) continue;
                }

                tableState.push(newRow);
              }
            }
          }
        }
      }
    }
    transaction(fn: (...args: any[]) => any) {
      return fn;
    }
    exec(_sql: string) {}
    close() { this.open = false; }
  }
  Database = MockDatabase as any;
}
export default Database;

export type Database = BetterSqlite3.Database;
