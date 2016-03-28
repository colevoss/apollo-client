import {
  NetworkInterface,
  Request,
} from './networkInterface';

import {
  parseQuery,
  parseMutation,
} from './parser';

import {
  assign,
  forOwn,
} from 'lodash';

import {
  createQueryResultAction,
  Store,
} from './store';

import {
  Store as ReduxStore,
} from 'redux';

import {
  SelectionSet,
  GraphQLError,
  GraphQLResult,
} from 'graphql';

import {
  readSelectionSetFromStore,
} from './readFromStore';

export class QueryManager {
  private networkInterface: NetworkInterface;
  private store: ReduxStore;
  private selectionSetMap: { [queryId: number]: SelectionSetWithRoot };

  private resultCallbacks: { [queryId: number]: QueryResultCallback[]};

  private idCounter = 0;

  constructor({
    networkInterface,
    store,
  }: {
    networkInterface: NetworkInterface,
    store: ReduxStore,
  }) {
    // XXX this might be the place to do introspection for inserting the `id` into the query? or
    // is that the network interface?
    this.networkInterface = networkInterface;
    this.store = store;

    this.selectionSetMap = {};
    this.resultCallbacks = {};

    this.store.subscribe(() => {
      this.broadcastNewStore(this.store.getState());
    });
  }

  public mutate({
    mutation,
    variables,
  }: {
    mutation: string,
    variables?: Object,
  }): Promise<any> {
    const mutationDef = parseMutation(mutation);

    const request = {
      query: mutation,
      variables,
    } as Request;

    return this.networkInterface.query(request)
      .then((result) => {
        const resultWithDataId = assign({
          __data_id: 'ROOT_MUTATION',
        }, result.data);

        this.store.dispatch(createQueryResultAction({
          result: resultWithDataId,
          selectionSet: mutationDef.selectionSet,
          variables,
        }));

        return result.data;
      });
  }

  public watchQuery({
     query,
     variables,
  }: {
    query: string,
    variables?: Object,
  }): WatchedQueryHandle {
    const queryDef = parseQuery(query);

    const watchHandle = this.watchSelectionSet({
      selectionSet: queryDef.selectionSet,
      rootId: 'ROOT_QUERY',
      typeName: 'Query',
      variables,
    });

    // XXX diff query against store to reduce network
    const request = {
      query: query,
      variables,
    } as Request;

    this.networkInterface.query(request)
      .then((result: GraphQLResult) => {
        let errors: GraphQLError[] = result.errors;

        if (errors && errors.length) {
          this.handleQueryErrorsAndStop(watchHandle.id, errors);
        }

        // XXX handle multiple GraphQLResults
        const resultWithDataId = assign({
          __data_id: 'ROOT_QUERY',
        }, result.data);

        this.store.dispatch(createQueryResultAction({
          result: resultWithDataId,
          selectionSet: queryDef.selectionSet,
          variables,
        }));
      }).catch((errors: GraphQLError[]) => {
        this.handleQueryErrorsAndStop(watchHandle.id, errors);
      });

    return watchHandle;
  }

  public broadcastNewStore(store: Store) {
    forOwn(this.selectionSetMap, (selectionSetWithRoot: SelectionSetWithRoot, queryId: string) => {
      const resultFromStore = readSelectionSetFromStore({
        store,
        rootId: selectionSetWithRoot.rootId,
        selectionSet: selectionSetWithRoot.selectionSet,
        variables: selectionSetWithRoot.variables,
      });

      this.broadcastQueryChange(queryId, resultFromStore);
    });
  }

  public watchSelectionSet(selectionSetWithRoot: SelectionSetWithRoot): WatchedQueryHandle {
    const queryId = this.idCounter.toString();
    this.idCounter++;

    this.selectionSetMap[queryId] = selectionSetWithRoot;

    const isStopped = () => {
      return ! this.selectionSetMap[queryId];
    };

    return {
      id: queryId,
      isStopped,
      stop: () => {
        this.stopQuery(queryId);
      },
      onResult: (callback) => {
        if (isStopped()) { throw new Error('Query was stopped. Please create a new one.'); }

        this.registerResultCallback(queryId, callback);
      },
    };
  }

  private stopQuery(queryId) {
    delete this.selectionSetMap[queryId];
    delete this.registerResultCallback[queryId];
  }

  private broadcastQueryChange(queryId: string, result: any) {
    this.resultCallbacks[queryId].forEach((callback) => {
      callback(null, result);
    });
  }

  private handleQueryErrorsAndStop(queryId: string, errors: GraphQLError[]) {
    const errorCallbacks: QueryResultCallback[] = this.resultCallbacks[queryId];

    this.stopQuery(queryId);

    if (errorCallbacks && errorCallbacks.length) {
      errorCallbacks.forEach((callback) => {
        callback(errors);
      });
    } else {
      // XXX maybe provide some info here?
      throw new Error('Uncaught query errors. Use onError on the query handle to get errors.');
    }
  }

  private registerResultCallback(queryId: string, callback: QueryResultCallback): void {
    if (! this.resultCallbacks[queryId]) {
      this.resultCallbacks[queryId] = [];
    }

    this.resultCallbacks[queryId].push(callback);
  }

}

export interface SelectionSetWithRoot {
  rootId: string;
  typeName: string;
  selectionSet: SelectionSet;
  variables: Object;
}

export interface WatchedQueryHandle {
  id: string;
  isStopped: () => boolean;
  stop();
  onResult(callback: QueryResultCallback);
}

export type QueryResultCallback = (error: GraphQLError[], result?: any) => void;