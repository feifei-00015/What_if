import { randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import TableStore from 'tablestore';

const EMPTY = { version: 2, guests: {}, stories: {}, days: {} };
const MAX_VALUE_BYTES = 1800000;

function call(client, method, params) {
  return new Promise((resolve, reject) => client[method](params, (error, result) => error ? reject(error) : resolve(result)));
}

export function createTablestoreState({ endpoint, instance, table, client = null } = {}) {
  if (!table || !instance || !endpoint || new URL(endpoint).protocol !== 'https:') {
    throw new Error('请配置有效的 TABLESTORE_ENDPOINT、TABLESTORE_INSTANCE 和 TABLESTORE_TABLE');
  }
  const store = client || new TableStore.Client({
    accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    secretAccessKey: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    stsToken: process.env.ALIBABA_CLOUD_SECURITY_TOKEN,
    endpoint,
    instancename: instance,
  });
  const key = [{ id: 'global' }];

  return {
    async load() {
      const result = await call(store, 'getRow', { tableName: table, primaryKey: key, maxVersions: 1 });
      const columns = Object.fromEntries((result.row?.attributes || []).map(column => [column.columnName, column.columnValue]));
      if (!columns.data && !columns.revision) return { data: structuredClone(EMPTY), revision: null };
      if (typeof columns.data !== 'string' || typeof columns.revision !== 'string') {
        throw new Error('表格存储状态行不完整');
      }
      const data = JSON.parse(inflateSync(Buffer.from(columns.data, 'base64')).toString('utf8'));
      if (data.version !== 2) throw new Error('表格存储状态版本不兼容');
      return { data, revision: columns.revision };
    },
    async save(data, revision) {
      const value = deflateSync(JSON.stringify(data)).toString('base64');
      if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new Error('表格存储状态容量已满，请清理过期记录');
      const condition = revision === null
        ? new TableStore.Condition(TableStore.RowExistenceExpectation.EXPECT_NOT_EXIST, null)
        : new TableStore.Condition(TableStore.RowExistenceExpectation.EXPECT_EXIST,
          new TableStore.SingleColumnCondition('revision', revision, TableStore.ComparatorType.EQUAL, false));
      try {
        await call(store, 'putRow', { tableName: table, primaryKey: key,
          attributeColumns: [{ data: value }, { revision: randomUUID() }], condition });
        return true;
      } catch (error) {
        if (error.code === 'OTSConditionCheckFail' || error.code === 'OTSRowOperationConflict') return false;
        throw error;
      }
    },
  };
}
