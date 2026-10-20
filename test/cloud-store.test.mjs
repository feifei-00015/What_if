import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrialStore } from '../backend/trial-store.mjs';
import { createTablestoreState } from '../backend/tablestore-state.mjs';
import { assertPublicModelUrl } from '../backend/model-network.mjs';

function fakeTable() {
  let columns = null;
  return {
    getRow(_params, done) {
      setImmediate(() => done(null, { row: { attributes: columns
        ? Object.entries(columns).map(([columnName, columnValue]) => ({ columnName, columnValue })) : [] } }));
    },
    putRow(params, done) {
      setImmediate(() => {
        const condition = params.condition;
        const expected = condition.columnCondition?.columnValue;
        if ((condition.rowExistenceExpectation === 2 && columns)
          || (condition.rowExistenceExpectation === 1 && (!columns || columns.revision !== expected))) {
          return done(Object.assign(new Error('conflict'), { code: 'OTSConditionCheckFail' }));
        }
        columns = Object.fromEntries(params.attributeColumns.flatMap(item => Object.entries(item)));
        done(null, {});
      });
    },
    get columns() { return columns; },
  };
}

test('two cloud-backed instances atomically enforce the site story budget', async () => {
  const client = fakeTable();
  const options = { endpoint: 'https://example.com', instance: 'trial', table: 'state', client };
  const left = createTrialStore(null, { stateBackend: createTablestoreState(options), limits: { siteStoriesPerDay: 1 } });
  const right = createTrialStore(null, { stateBackend: createTablestoreState(options), limits: { siteStoriesPerDay: 1 } });
  const [a, b] = await Promise.all([left.guest(), right.guest()]);
  const input = { scenario: '如果重新谈谈', context: '两人此前失去联系。', mode: 'light' };
  const outcomes = await Promise.allSettled([left.createStory(a.token, input), right.createStory(b.token, input)]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.status, 429);
  assert.equal((await left.status(a.token)).remainingToday + (await right.status(b.token)).remainingToday, 3);
  assert.equal(client.columns.data.includes('两人此前失去联系'), false);
});

test('personal model endpoint rejects internal addresses before a model request', () => {
  for (const address of ['https://127.0.0.1/v1', 'https://10.0.0.5/v1',
    'https://169.254.169.254/v1', 'https://[::1]/v1', 'https://[::ffff:127.0.0.1]/v1',
    'https://metadata.internal/v1']) {
    assert.throws(() => assertPublicModelUrl(new URL(address)), /内部网络/);
  }
  assert.doesNotThrow(() => assertPublicModelUrl(new URL('https://api.example.com/v1')));
});
