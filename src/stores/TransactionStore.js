/* eslint-disable no-shadow */
import { types as t, getEnv, getRoot } from 'mobx-state-tree';
import { StripeService } from '../services';

import createFlow from './helpers/createFlow';
import processJsonApi, {
  processJsonApiTransactions,
} from './utils/processJsonApi';
import listModel from './utils/listModel';
import { MessageStore } from './MessagesStore';
import { Price, Product } from './ListingsStore';
import { normalizedIncluded } from './utils/normalize';

// const LineItems = t.model('LineItems', {
//   code: t.string,
//   quantity: t.number,
//   reversal: t.boolean,
//   unitPrice: Price,
//   lineTotal: Price,
//   includeFor: t.array(t.string),
// });

// const Transitions = t
//   .model('Transactions', {
//     transition: t.string,
//     createdAt: t.Date,
//     by: t.string,
//   })
// .preProcessSnapshot((snapshot) => ({
//   ...snapshot,
//   createdAt: new Date(snapshot.createdAt),
// }));

const Relationships = t.model('Relationships', {
  listing: t.maybe(t.reference(Product)),
});

export const Transaction = t
  .model('Transaction', {
    id: t.identifier,
    type: t.maybe(t.string),
    createdAt: t.Date,
    processName: t.string,
    processVersion: t.number,
    lastTransition: t.maybe(t.string),
    lastTransitionedAt: t.maybe(t.Date),
    payinTotal: t.maybeNull(Price),
    payoutTotal: t.maybeNull(Price),
    // lineItems: t.maybe(t.array(LineItems)),
    protectedData: t.model({}),
    // transitions: t.maybe(t.array(Transitions)),
    messages: t.optional(MessageStore, {}),

    relationships: t.maybe(Relationships),
    changeStateTransactions: createFlow(changeStateTransactions),
  })
  .views((store) => ({
    get Api() {
      return getEnv(store).Api;
    },

    get imageUrl() {
      return store.relationships.listing.relationships.getImages[0]
        .variants.default.url;
    },
  }))
  .actions((store) => ({
    update(snapshot) {
      Object.assign(store, snapshot);
    },
  }));

function changeStateTransactions(flow, store) {
  return function* initiatechangeStateTransactionsTransaction(
    transition,
  ) {
    try {
      flow.start();
      const res = yield store.Api.changeStateTransactions({
        transactionId: store.id,
        transition,
      });

      const snapshot = processJsonApiTransactions(res.data.data);
      store.update(snapshot);
      flow.success();
    } catch (err) {
      flow.failed(err, true);
    }
  };
}

const TransactionList = listModel('TransactionList', {
  of: t.reference(Transaction),
  entityName: 'transaction',
  identifierName: 'id',
  responseTransformer,
  perPage: 15,
});

function responseTransformer(res) {
  // if (Array.isArray(res)) {
  //   return res.map((i) => processJsonApi(i));
  // }
  return res.map(processJsonApi);
}

export const TransactionStore = t
  .model('ListingsStore', {
    list: TransactionList,
    initiateTransaction: createFlow(initiateTransaction),

    initiateMessageTransaction: createFlow(
      initiateMessageTransaction,
    ),
    // fetchChatTransaction: createFlow(fetchChatTransaction),
    fetchTransactions: createFlow(fetchTransactions),
    fetchMoreTransactions: createFlow(fetchMoreTransactions),
    changeStateTransactions: createFlow(changeStateTransactions),
    fetchTransactionById: createFlow(fetchTransactionById),
  })
  .views((store) => ({
    get Api() {
      return getEnv(store).Api;
    },
  }))

  .actions((store) => ({
    update(snapshot) {
      Object.assign(store, snapshot);
    },
  }));

function initiateMessageTransaction(flow, store) {
  return function* initiateMessage(listingId) {
    try {
      flow.start();

      const res = yield flow.Api.initiateMessageTransaction(
        listingId,
      );

      const data = processJsonApi(res.data.data);
      console.log('data: ', data);
      // getParent(store, 2).add(data)
      store.list.add(data);

      flow.success();
    } catch (err) {
      flow.failed(err, true);
    }
  };
}

function initiateTransaction(flow, store) {
  return function* initiateTransaction({
    listingId,
    startRent,
    endRent,
    cardNumber,
    monthExpiration,
    yearExpiration,
    cardCVC,
    message,
  }) {
    try {
      flow.start();
      const expMonth = Number(monthExpiration);
      const expYear = Number(yearExpiration);

      const params = {
        number: cardNumber,
        expMonth,
        expYear,
        cvc: cardCVC,
      };

      const cardToken = yield StripeService.createTokenWithCard(
        params,
      );

      const { tokenId } = cardToken;

      const res = yield store.Api.initiateTransaction({
        listingId,
        startRent,
        endRent,
        cardToken: tokenId,
      });
      const normalizedEntities = normalizedIncluded(
        res.data.included,
      );
      getRoot(store).entities.merge(normalizedEntities);

      const data = processJsonApi(res.data.data);
      store.list.addToBegin(data);

      if (message) {
        yield store.Api.sendMessage({
          transactionId: data.id,
          content: message,
          include: ['sender', 'sender.profileImage'],
        });
      }

      flow.success();
    } catch (err) {
      flow.failed(err, true);
    }
  };
}

function fetchTransactionById(flow, store) {
  return function* fetchTransaction(transactionId) {
    try {
      flow.start();

      const res = yield store.Api.transactionsShow({
        transactionId,
      });
      const normalizedEntities = normalizedIncluded(
        res.data.included,
      );
      getRoot(store).entities.merge(normalizedEntities);

      // store.list.set(res.data.data);
      const data = processJsonApiTransactions(res.data.data);
      store.list.add(data);
      flow.success();
    } catch (err) {
      flow.failed(err, true);
    }
  };
}

function fetchTransactions(flow, store) {
  return function* fetchTransaction() {
    try {
      flow.start();

      const res = yield store.Api.fetchTransactions({
        perPage: 15,
        page: 1,
      });
      const normalizedEntities = normalizedIncluded(
        res.data.included,
      );
      getRoot(store).entities.merge(normalizedEntities);

      // TODO: Fetch listings for each transaction
      // since transaction doesn't include the listing relationships
      // We have to fetch each listing by it id
      // Fetching multiple listings by array of ids is not currently supported

      store.list.set(res.data.data);
      flow.success();
    } catch (err) {
      flow.failed(err, true);
    }
  };
}

function fetchMoreTransactions(flow, store) {
  return function* fetchTransactions() {
    try {
      if (store.list.hasNoMore || flow.inProgress) {
        return;
      }

      flow.start();
      const page = store.list.pageNumber;
      const perPage = 15;

      const res = yield store.Api.fetchTransactions({
        perPage,
        page,
      });

      const normalizedEntities = normalizedIncluded(
        res.data.included,
      );
      getRoot(store).entities.merge(normalizedEntities);

      store.list.append(res.data.data);

      flow.success();
    } catch (err) {
      flow.failed(err, true);
    }
  };
}

// function fetchChatTransaction(flow, store) {
//   return function* initiateTransaction(listingId) {
//     try {
//       flow.start();

//       const res = yield store.Api.transactionsQuery({
//         // only: 'order',
//         // lastTransitions: ['transition/request'],
//       });

//       const transactions = res.data.data.map((i) =>
//         processJsonApi(i),
//       );

//       const normalizedEntities = normalizedIncluded(
//         res.data.included,
//       );

//       // const listingsTransaction = transactions.filter(
//       //   (i) =>
//       //     i.relationships.listing.toString() === listingId.toString(),
//       // );
//       const listingTransaction = transactions[0];
//       // const listingsTransaction = transactions.slice(-1)[0];

//       // let listingTransaction;
//       // if (Array.isArray(listingsTransaction)) {
//       //   listingTransaction = listingsTransaction[0];
//       // } else {
//       //   listingTransaction = listingsTransaction;
//       // }
//       if (
//         // listingTransaction.length === 0 &&
//         typeof listingTransaction === 'undefined'
//       ) {
//         store.initiateMessageTransaction.run(listingId);
//       } else {
//         store.list.add(listingTransaction);
//       }

//       // debugger;

//       flow.success();
//     } catch (err) {
//       // debugger;
//       flow.failed(err, true);
//     }
//   };
// }

export default TransactionStore;
