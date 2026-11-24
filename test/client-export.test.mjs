import assert from 'node:assert/strict';
import test from 'node:test';
import * as native from '@functional-systems/lambdadb';
import { HTTPClient, LambdaDBClient } from '@functional-systems/memdrive';

test('the SDK re-exports the pinned LambdaDB client classes themselves', () => {
    assert.equal(LambdaDBClient, native.LambdaDBClient);
    assert.equal(HTTPClient, native.HTTPClient);
});
