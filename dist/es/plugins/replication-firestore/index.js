import _inheritsLoose from "@babel/runtime/helpers/inheritsLoose";
import { ensureNotFalsy, errorToPlainJson, flatClone, lastOfArray } from '../../plugins/utils';
import { doc, query, where, orderBy, limit, getDocs, onSnapshot, runTransaction, writeBatch, serverTimestamp, waitForPendingWrites, documentId } from 'firebase/firestore';
import { RxDBLeaderElectionPlugin } from '../leader-election';
import { RxReplicationState, startReplicationOnLeaderShip } from '../replication';
import { addRxPlugin, getSchemaByObjectPath, newRxError } from '../../';
import { Subject } from 'rxjs';
import { firestoreRowToDocData, FIRESTORE_REPLICATION_PLUGIN_IDENTITY_PREFIX, getContentByIds, isoStringToServerTimestamp, serverTimestampToIsoString, stripPrimaryKey, stripServerTimestampField } from './firestore-helper';
export * from './firestore-helper';
export * from './firestore-types';
export var RxFirestoreReplicationState = /*#__PURE__*/function (_RxReplicationState) {
  _inheritsLoose(RxFirestoreReplicationState, _RxReplicationState);
  function RxFirestoreReplicationState(firestore, replicationIdentifierHash, collection, pull, push, live = true, retryTime = 1000 * 5, autoStart = true) {
    var _this;
    _this = _RxReplicationState.call(this, replicationIdentifierHash, collection, '_deleted', pull, push, live, retryTime, autoStart) || this;
    _this.firestore = firestore;
    _this.replicationIdentifierHash = replicationIdentifierHash;
    _this.collection = collection;
    _this.pull = pull;
    _this.push = push;
    _this.live = live;
    _this.retryTime = retryTime;
    _this.autoStart = autoStart;
    return _this;
  }
  return RxFirestoreReplicationState;
}(RxReplicationState);
export function replicateFirestore(options) {
  var collection = options.collection;
  addRxPlugin(RxDBLeaderElectionPlugin);
  var pullStream$ = new Subject();
  var replicationPrimitivesPull;
  options.live = typeof options.live === 'undefined' ? true : options.live;
  options.waitForLeadership = typeof options.waitForLeadership === 'undefined' ? true : options.waitForLeadership;
  var serverTimestampField = typeof options.serverTimestampField === 'undefined' ? 'serverTimestamp' : options.serverTimestampField;
  options.serverTimestampField = serverTimestampField;
  var primaryPath = collection.schema.primaryPath;

  /**
   * The serverTimestampField MUST NOT be part of the collections RxJsonSchema.
   */
  var schemaPart = getSchemaByObjectPath(collection.schema.jsonSchema, serverTimestampField);
  if (schemaPart ||
  // also must not be nested.
  serverTimestampField.includes('.')) {
    throw newRxError('RC6', {
      field: serverTimestampField,
      schema: collection.schema.jsonSchema
    });
  }
  if (options.pull) {
    replicationPrimitivesPull = {
      async handler(lastPulledCheckpoint, batchSize) {
        var newerQuery;
        var sameTimeQuery;
        if (lastPulledCheckpoint) {
          var lastServerTimestamp = isoStringToServerTimestamp(lastPulledCheckpoint.serverTimestamp);
          newerQuery = query(options.firestore.collection, where(serverTimestampField, '>', lastServerTimestamp), orderBy(serverTimestampField, 'asc'), limit(batchSize));
          sameTimeQuery = query(options.firestore.collection, where(serverTimestampField, '==', lastServerTimestamp), where(primaryPath, '>', lastPulledCheckpoint.id), orderBy(primaryPath, 'asc'), limit(batchSize));
        } else {
          newerQuery = query(options.firestore.collection, orderBy(serverTimestampField, 'asc'), limit(batchSize));
        }
        var mustsReRun = true;
        var useDocs = [];
        while (mustsReRun) {
          /**
           * Local writes that have not been persisted to the server
           * are in pending state and do not have a correct serverTimestamp set.
           * We have to ensure we only use document states that are in sync with the server.
           * @link https://medium.com/firebase-developers/the-secrets-of-firestore-fieldvalue-servertimestamp-revealed-29dd7a38a82b
           */
          await waitForPendingWrites(options.firestore.database);
          await runTransaction(options.firestore.database, async _tx => {
            useDocs = [];
            var [newerQueryResult, sameTimeQueryResult] = await Promise.all([getDocs(newerQuery), sameTimeQuery ? getDocs(sameTimeQuery) : undefined]);
            if (newerQueryResult.metadata.hasPendingWrites || sameTimeQuery && ensureNotFalsy(sameTimeQueryResult).metadata.hasPendingWrites) {
              return;
            } else {
              mustsReRun = false;
              if (sameTimeQuery) {
                useDocs = ensureNotFalsy(sameTimeQueryResult).docs;
              }
              var missingAmount = batchSize - useDocs.length;
              if (missingAmount > 0) {
                var additionalDocs = newerQueryResult.docs.slice(0, missingAmount).filter(x => !!x);
                useDocs = useDocs.concat(additionalDocs);
              }
            }
          });
        }
        if (useDocs.length === 0) {
          return {
            checkpoint: lastPulledCheckpoint,
            documents: []
          };
        }
        var lastDoc = ensureNotFalsy(lastOfArray(useDocs));
        var documents = useDocs.map(row => firestoreRowToDocData(serverTimestampField, primaryPath, row));
        var newCheckpoint = {
          id: lastDoc.id,
          serverTimestamp: serverTimestampToIsoString(serverTimestampField, lastDoc.data())
        };
        var ret = {
          documents: documents,
          checkpoint: newCheckpoint
        };
        return ret;
      },
      batchSize: ensureNotFalsy(options.pull).batchSize,
      modifier: ensureNotFalsy(options.pull).modifier,
      stream$: pullStream$.asObservable()
    };
  }
  var replicationPrimitivesPush;
  if (options.push) {
    replicationPrimitivesPush = {
      async handler(rows) {
        var writeRowsById = {};
        var docIds = rows.map(row => {
          var docId = row.newDocumentState[primaryPath];
          writeRowsById[docId] = row;
          return docId;
        });
        await waitForPendingWrites(options.firestore.database);
        var conflicts = [];

        /**
         * Everything must run INSIDE of the transaction
         * because on tx-errors, firebase will re-run the transaction on some cases.
         * @link https://firebase.google.com/docs/firestore/manage-data/transactions#transaction_failure
         * @link https://firebase.google.com/docs/firestore/manage-data/transactions
         */
        await runTransaction(options.firestore.database, async _tx => {
          conflicts = []; // reset in case the tx has re-run.
          /**
           * @link https://stackoverflow.com/a/48423626/3443137
           */

          var getQuery = ids => {
            return getDocs(query(options.firestore.collection, where(documentId(), 'in', ids)));
          };
          var docsInDbResult = await getContentByIds(docIds, getQuery);
          var docsInDbById = {};
          docsInDbResult.forEach(row => {
            var docDataInDb = stripServerTimestampField(serverTimestampField, row.data());
            var docId = row.id;
            docDataInDb[primaryPath] = docId;
            docsInDbById[docId] = docDataInDb;
          });

          /**
           * @link https://firebase.google.com/docs/firestore/manage-data/transactions#batched-writes
           */
          var batch = writeBatch(options.firestore.database);
          var hasWrite = false;
          await Promise.all(Object.entries(writeRowsById).map(async ([docId, writeRow]) => {
            var docInDb = docsInDbById[docId];
            if (docInDb && (!writeRow.assumedMasterState || (await collection.conflictHandler({
              newDocumentState: docInDb,
              realMasterState: writeRow.assumedMasterState
            }, 'replication-firestore-push')).isEqual === false)) {
              // conflict
              conflicts.push(docInDb);
            } else {
              // no conflict
              hasWrite = true;
              var docRef = doc(options.firestore.collection, docId);
              var writeDocData = flatClone(writeRow.newDocumentState);
              writeDocData[serverTimestampField] = serverTimestamp();
              if (!docInDb) {
                // insert
                batch.set(docRef, stripPrimaryKey(primaryPath, writeDocData));
              } else {
                // update
                batch.update(docRef, stripPrimaryKey(primaryPath, writeDocData));
              }
            }
          }));
          if (hasWrite) {
            await batch.commit();
          }
        });
        await waitForPendingWrites(options.firestore.database);
        return conflicts;
      },
      batchSize: options.push.batchSize,
      modifier: options.push.modifier
    };
  }
  var replicationState = new RxFirestoreReplicationState(options.firestore, FIRESTORE_REPLICATION_PLUGIN_IDENTITY_PREFIX + options.collection.database.hashFunction(options.firestore.projectId), collection, replicationPrimitivesPull, replicationPrimitivesPush, options.live, options.retryTime, options.autoStart);

  /**
   * Use long polling to get live changes for the pull.stream$
   */
  if (options.live && options.pull) {
    var startBefore = replicationState.start.bind(replicationState);
    var cancelBefore = replicationState.cancel.bind(replicationState);
    replicationState.start = () => {
      var lastChangeQuery = query(options.firestore.collection, orderBy(serverTimestampField, 'desc'), limit(1));
      var unsubscribe = onSnapshot(lastChangeQuery, _querySnapshot => {
        /**
         * There is no good way to observe the event stream in firestore.
         * So instead we listen to any write to the collection
         * and then emit a 'RESYNC' flag.
         */
        replicationState.reSync();
      }, error => {
        replicationState.subjects.error.next(newRxError('RC_STREAM', {
          error: errorToPlainJson(error)
        }));
      });
      replicationState.cancel = () => {
        unsubscribe();
        return cancelBefore();
      };
      return startBefore();
    };
  }
  startReplicationOnLeaderShip(options.waitForLeadership, replicationState);
  return replicationState;
}
//# sourceMappingURL=index.js.map