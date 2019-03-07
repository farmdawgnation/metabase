import moment from "moment";
import _ from "underscore";
import { getIn } from "icepick";

import { setRequestState, clearRequestState } from "metabase/redux/requests";

// convienence
export { combineReducers, compose } from "redux";
export { handleActions, createAction } from "redux-actions";

import { createSelectorCreator } from "reselect";
import memoize from "lodash.memoize";

// similar to createAction but accepts a (redux-thunk style) thunk and dispatches based on whether
// the promise returned from the thunk resolves or rejects, similar to redux-promise
export function createThunkAction(actionType, thunkCreator) {
  return withAction(actionType)(thunkCreator);
}

// turns string timestamps into moment objects
export function momentifyTimestamps(
  object,
  keys = ["created_at", "updated_at"],
) {
  object = { ...object };
  for (let timestamp of keys) {
    if (object[timestamp]) {
      object[timestamp] = moment(object[timestamp]);
    }
  }
  return object;
}

export function momentifyObjectsTimestamps(objects, keys) {
  return _.mapObject(objects, o => momentifyTimestamps(o, keys));
}

export function momentifyArraysTimestamps(array, keys) {
  return _.map(array, o => momentifyTimestamps(o, keys));
}

// turns into id indexed map
export const resourceListToMap = resources =>
  resources.reduce(
    (map, resource) => ({ ...map, [resource.id]: resource }),
    {},
  );

export const fetchData = async ({
  dispatch,
  getState,
  requestStatePath,
  existingStatePath,
  getData,
  reload = false,
  properties = null,
}) => {
  const existingData = getIn(getState(), existingStatePath);

  // short circuit if we have loaded data, and we're givein a list of required properties, and they all existing in the loaded data
  if (
    !reload &&
    existingData &&
    properties &&
    _.all(properties, p => existingData[p] !== undefined)
  ) {
    return existingData;
  }

  const statePath = requestStatePath.concat(["fetch"]);
  try {
    const requestState = getIn(getState(), [
      "requests",
      "states",
      ...statePath,
    ]);
    if (!requestState || requestState.error || reload) {
      dispatch(setRequestState({ statePath, state: "LOADING" }));
      const data = await getData();

      // NOTE Atte Keinänen 8/23/17:
      // Dispatch `setRequestState` after clearing the call stack because we want to the actual data to be updated
      // before we notify components via `state.requests.fetches` that fetching the data is completed
      setTimeout(
        () => dispatch(setRequestState({ statePath, state: "LOADED" })),
        0,
      );

      return data;
    }

    return existingData;
  } catch (error) {
    dispatch(setRequestState({ statePath, error }));
    console.error("fetchData error", error);
    return existingData;
  }
};

export const updateData = async ({
  dispatch,
  getState,
  requestStatePath,
  existingStatePath,
  // specify any request paths that need to be invalidated after this update
  dependentRequestStatePaths,
  putData,
}) => {
  const existingData = existingStatePath
    ? getIn(getState(), existingStatePath)
    : null;
  const statePath = requestStatePath.concat(["update"]);
  try {
    dispatch(setRequestState({ statePath, state: "LOADING" }));
    const data = await putData();
    dispatch(setRequestState({ statePath, state: "LOADED" }));

    (dependentRequestStatePaths || []).forEach(statePath =>
      dispatch(clearRequestState({ statePath })),
    );

    return data;
  } catch (error) {
    dispatch(setRequestState({ statePath, error }));
    console.error(error);
    return existingData;
  }
};

// helper for working with normalizr
// merge each entity from newEntities with existing entity, if any
// this ensures partial entities don't overwrite existing entities with more properties
export function mergeEntities(entities, newEntities) {
  entities = { ...entities };
  for (const id in newEntities) {
    if (id in entities) {
      entities[id] = { ...entities[id], ...newEntities[id] };
    } else {
      entities[id] = newEntities[id];
    }
  }
  return entities;
}

// helper for working with normalizr
// reducer that merges payload.entities
export function handleEntities(
  actionPattern,
  entityType,
  reducer = (state = {}, action) => state,
) {
  return (state, action) => {
    if (state === undefined) {
      state = {};
    }
    let entities = getIn(action, ["payload", "entities", entityType]);
    if (actionPattern.test(action.type) && entities) {
      state = mergeEntities(state, entities);
    }
    return reducer(state, action);
  };
}

// for filtering non-DOM props from redux-form field objects
// https://github.com/erikras/redux-form/issues/1441
export const formDomOnlyProps = ({
  initialValue,
  autofill,
  onUpdate,
  valid,
  invalid,
  dirty,
  pristine,
  active,
  touched,
  visited,
  autofilled,
  error,
  defaultValue,
  ...domProps
}) => domProps;

export const createMemoizedSelector = createSelectorCreator(
  memoize,
  (...args) => JSON.stringify(args),
);

// THUNK DECORATORS

export function withAction(actionType) {
  return creator => {
    function newCreator(...actionArgs) {
      const payloadOrThunk = creator(...actionArgs);
      if (typeof payloadOrThunk === "function") {
        return async (dispatch, getState) => {
          try {
            let payload = await payloadOrThunk(dispatch, getState);
            let dispatchValue = { type: actionType, payload: payload };
            dispatch(dispatchValue);

            return dispatchValue;
          } catch (error) {
            dispatch({ type: actionType, payload: error, error: true });
            throw error;
          }
        };
      } else {
        return { type: actionType, payload: payloadOrThunk };
      }
    }
    newCreator.toString = () => actionType;
    return newCreator;
  };
}

export function withRequestState(getStatePath) {
  // thunk decorator:
  return thunkCreator =>
    // thunk creator:
    (...args) =>
      // thunk:
      (dispatch, getState) => {
        const statePath = getStatePath(...args);
        try {
          dispatch(setRequestState({ statePath, state: "LOADING" }));
          const result = thunkCreator(...args)(dispatch, getState);
          dispatch(setRequestState({ statePath, state: "LOADED" }));
          return result;
        } catch (error) {
          console.error(`Request ${statePath.join(",")} failed:`, error);
          dispatch(setRequestState({ statePath, error }));
          throw error;
        }
      };
}

import MetabaseAnalytics from "metabase/lib/analytics";

export function withAnalytics(categoryOrFn, actionOrFn, labelOrFn, valueOrFn) {
  // thunk decorator:
  return thunkCreator =>
    // thunk creator:
    (...args) =>
      // thunk:
      (dispatch, getState) => {
        function get(valueOrFn, extra = {}) {
          if (typeof valueOrFn === "function") {
            return valueOrFn(args, { ...extra }, getState);
          }
        }
        try {
          const category = get(categoryOrFn);
          const action = get(actionOrFn, { category });
          const label = get(labelOrFn, { category, action });
          const value = get(valueOrFn, { category, action, label });
          MetabaseAnalytics.trackEvent(category, action, label, value);
        } catch (error) {
          console.warn("withAnalytics threw an error:", error);
        }
        return thunkCreator(...args)(dispatch, getState);
      };
}
