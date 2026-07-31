// ─── PROTOTYPE & INTERACTION HANDLERS ────────────────────────────────────────

var PROTOTYPE_TRIGGER_ALIASES = {
  ON_TAP: "ON_CLICK",
  AFTER_DELAY: "AFTER_TIMEOUT",
  KEY_DOWN: "ON_KEY_DOWN",
};

var PROTOTYPE_TRIGGER_TYPES = {
  ON_CLICK: true,
  ON_HOVER: true,
  ON_PRESS: true,
  ON_DRAG: true,
  ON_MEDIA_END: true,
  AFTER_TIMEOUT: true,
  MOUSE_UP: true,
  MOUSE_DOWN: true,
  MOUSE_ENTER: true,
  MOUSE_LEAVE: true,
  ON_KEY_DOWN: true,
  ON_MEDIA_HIT: true,
};

var PROTOTYPE_NODE_NAVIGATION_ALIASES = {
  NAVIGATE: "NAVIGATE",
  OPEN_OVERLAY: "OVERLAY",
  OVERLAY: "OVERLAY",
  SWAP: "SWAP",
  SCROLL_TO: "SCROLL_TO",
  CHANGE_TO: "CHANGE_TO",
};

var PROTOTYPE_ACTION_TYPES = {
  BACK: true,
  CLOSE: true,
  URL: true,
  SET_VARIABLE: true,
  SET_VARIABLE_MODE: true,
  CONDITIONAL: true,
  UPDATE_MEDIA_RUNTIME: true,
};

var PROTOTYPE_TRANSITION_TYPES = {
  DISSOLVE: true,
  SMART_ANIMATE: true,
  SCROLL_ANIMATE: true,
  MOVE_IN: true,
  MOVE_OUT: true,
  PUSH: true,
  SLIDE_IN: true,
  SLIDE_OUT: true,
};

var PROTOTYPE_DIRECTIONAL_TRANSITIONS = {
  MOVE_IN: true,
  MOVE_OUT: true,
  PUSH: true,
  SLIDE_IN: true,
  SLIDE_OUT: true,
};

var PROTOTYPE_EASING_TYPES = {
  EASE_IN: true,
  EASE_OUT: true,
  EASE_IN_AND_OUT: true,
  LINEAR: true,
  EASE_IN_BACK: true,
  EASE_OUT_BACK: true,
  EASE_IN_AND_OUT_BACK: true,
  CUSTOM_CUBIC_BEZIER: true,
  GENTLE: true,
  QUICK: true,
  BOUNCY: true,
  SLOW: true,
  CUSTOM_SPRING: true,
};

function clonePrototypeValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function prototypeErrorMessage(error) {
  if (error && error.message) return error.message;
  return String(error);
}

function prototypeDelay(milliseconds) {
  return new Promise(function(resolve) {
    setTimeout(resolve, milliseconds);
  });
}

function normalizePrototypeTrigger(input) {
  var trigger = typeof input === "string" ? { type: input } : clonePrototypeValue(input);
  if (!trigger || typeof trigger !== "object") {
    throw new Error("Each reaction requires a trigger object or trigger type string.");
  }

  var type = String(trigger.type || "").toUpperCase();
  type = PROTOTYPE_TRIGGER_ALIASES[type] || type;
  if (!PROTOTYPE_TRIGGER_TYPES[type]) {
    throw new Error(
      "Unsupported prototype trigger: " + (trigger.type || "(missing)") +
      ". Supported: " + Object.keys(PROTOTYPE_TRIGGER_TYPES).join(", ")
    );
  }
  trigger.type = type;

  if (type === "AFTER_TIMEOUT") {
    var timeout = trigger.timeout !== undefined ? trigger.timeout : trigger.delay;
    if (!Number.isFinite(Number(timeout)) || Number(timeout) < 0) {
      throw new Error("AFTER_TIMEOUT requires a non-negative timeout in milliseconds.");
    }
    trigger.timeout = Number(timeout);
    delete trigger.delay;
  }
  if (
    type === "MOUSE_UP" ||
    type === "MOUSE_DOWN" ||
    type === "MOUSE_ENTER" ||
    type === "MOUSE_LEAVE"
  ) {
    trigger.delay = Number(trigger.delay || 0);
    if (trigger.delay < 0) throw new Error(type + " delay must be non-negative.");
    if (type === "MOUSE_ENTER" || type === "MOUSE_LEAVE") {
      trigger.deprecatedVersion = Boolean(trigger.deprecatedVersion);
    }
  }
  if (type === "ON_KEY_DOWN") {
    trigger.device = trigger.device || "KEYBOARD";
    if (!Array.isArray(trigger.keyCodes) || !trigger.keyCodes.length) {
      throw new Error("ON_KEY_DOWN requires a non-empty keyCodes array.");
    }
    trigger.keyCodes = trigger.keyCodes.map(function(code) { return Number(code); });
  }
  if (type === "ON_MEDIA_HIT") {
    var mediaHitTime = trigger.mediaHitTime !== undefined
      ? trigger.mediaHitTime
      : trigger.timestamp;
    if (!Number.isFinite(Number(mediaHitTime)) || Number(mediaHitTime) < 0) {
      throw new Error("ON_MEDIA_HIT requires a non-negative mediaHitTime in seconds.");
    }
    trigger.mediaHitTime = Number(mediaHitTime);
    delete trigger.timestamp;
  }
  return trigger;
}

function normalizePrototypeTransition(input) {
  if (input === null || input === undefined || input === false) return null;
  var transition = typeof input === "string" ? { type: input } : clonePrototypeValue(input);
  var type = String(transition.type || "").toUpperCase();
  if (type === "NONE" || type === "INSTANT") return null;
  if (!PROTOTYPE_TRANSITION_TYPES[type]) {
    throw new Error(
      "Unsupported prototype transition: " + (transition.type || "(missing)") +
      ". Supported: " + Object.keys(PROTOTYPE_TRANSITION_TYPES).join(", ") +
      ", INSTANT"
    );
  }

  transition.type = type;
  transition.duration = transition.duration === undefined ? 0.3 : Number(transition.duration);
  if (!Number.isFinite(transition.duration) || transition.duration < 0 || transition.duration > 60) {
    throw new Error("Transition duration must be between 0 and 60 seconds.");
  }

  var easing = transition.easing;
  if (typeof easing === "string") easing = { type: easing };
  if (!easing) easing = { type: "EASE_OUT" };
  easing = clonePrototypeValue(easing);
  easing.type = String(easing.type || "").toUpperCase();
  if (!PROTOTYPE_EASING_TYPES[easing.type]) {
    throw new Error("Unsupported prototype easing: " + (easing.type || "(missing)"));
  }
  transition.easing = easing;

  if (PROTOTYPE_DIRECTIONAL_TRANSITIONS[type]) {
    transition.direction = String(transition.direction || "RIGHT").toUpperCase();
    if (["LEFT", "RIGHT", "TOP", "BOTTOM"].indexOf(transition.direction) === -1) {
      throw new Error("Directional transitions require LEFT, RIGHT, TOP, or BOTTOM.");
    }
    transition.matchLayers = Boolean(transition.matchLayers);
  } else {
    delete transition.direction;
    delete transition.matchLayers;
  }
  return transition;
}

async function normalizePrototypeAction(input, warnings) {
  var action = clonePrototypeValue(input);
  if (!action || typeof action !== "object") {
    throw new Error("Each reaction action must be an object.");
  }

  var type = String(action.type || "").toUpperCase();
  var navigation = action.navigation
    ? String(action.navigation).toUpperCase()
    : null;

  if (PROTOTYPE_NODE_NAVIGATION_ALIASES[type]) {
    navigation = PROTOTYPE_NODE_NAVIGATION_ALIASES[type];
    type = "NODE";
  } else if (type === "NODE") {
    navigation = PROTOTYPE_NODE_NAVIGATION_ALIASES[navigation] || navigation;
  } else if (type === "CLOSE_OVERLAY") {
    type = "CLOSE";
  } else if (type === "OPEN_URL") {
    type = "URL";
  }

  if (type === "NODE") {
    if (!PROTOTYPE_NODE_NAVIGATION_ALIASES[navigation]) {
      throw new Error(
        "NODE action requires navigation: NAVIGATE, OVERLAY, SWAP, SCROLL_TO, or CHANGE_TO."
      );
    }
    if (!action.destinationId) {
      throw new Error("NODE/" + navigation + " action requires destinationId.");
    }

    var destination = await findNodeByIdAsync(action.destinationId);
    if (!destination) {
      throw new Error("Prototype destination not found: " + action.destinationId);
    }
    if (navigation === "CHANGE_TO" && destination.type !== "COMPONENT") {
      throw new Error(
        "CHANGE_TO destination must be a COMPONENT variant, got " + destination.type + "."
      );
    }
    if (
      navigation !== "CHANGE_TO" &&
      ["FRAME", "COMPONENT", "INSTANCE", "SECTION"].indexOf(destination.type) === -1
    ) {
      warnings.push(
        navigation + " destination " + destination.name + " is a " + destination.type +
        "; a FRAME is normally expected."
      );
    }

    action.type = "NODE";
    action.navigation = navigation;
    action.destinationId = destination.id;
    action.transition = normalizePrototypeTransition(action.transition);
    action.preserveScrollPosition = Boolean(action.preserveScrollPosition);
    if (action.overlayRelativePosition) {
      action.overlayRelativePosition = {
        x: Number(action.overlayRelativePosition.x || 0),
        y: Number(action.overlayRelativePosition.y || 0),
      };
    }
    return action;
  }

  if (!PROTOTYPE_ACTION_TYPES[type]) {
    throw new Error(
      "Unsupported prototype action: " + (action.type || "(missing)") +
      ". Use NODE navigation, BACK, CLOSE, URL, SET_VARIABLE, SET_VARIABLE_MODE, " +
      "CONDITIONAL, or UPDATE_MEDIA_RUNTIME."
    );
  }
  action.type = type;
  if (type === "URL" && !action.url) {
    throw new Error("URL action requires url.");
  }
  return action;
}

async function normalizePrototypeReaction(input, warnings) {
  if (!input || typeof input !== "object") {
    throw new Error("Each reaction must be an object.");
  }
  var trigger = normalizePrototypeTrigger(input.trigger);
  var actionInputs = Array.isArray(input.actions)
    ? input.actions
    : (input.action ? [input.action] : []);
  if (!actionInputs.length) {
    throw new Error("Each reaction requires a non-empty actions array.");
  }
  var actions = [];
  for (var index = 0; index < actionInputs.length; index++) {
    actions.push(await normalizePrototypeAction(actionInputs[index], warnings));
  }
  return { trigger: trigger, actions: actions };
}

function readPrototypeReactions(node) {
  if (!("reactions" in node)) {
    throw new Error("Node type " + node.type + " does not support prototype reactions.");
  }
  return clonePrototypeValue(node.reactions || []);
}

async function writePrototypeReactions(node, reactions) {
  if (typeof node.setReactionsAsync === "function") {
    var asyncError = null;
    // Newly-created frames may not be registered with Figma's prototype host
    // immediately. The first call can time out even though the node is valid.
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await prototypeDelay(attempt * 500);
        await node.setReactionsAsync(reactions);
        return;
      } catch (error) {
        asyncError = error;
      }
    }

    // Older/local Figma runtimes may still expose a writable legacy property.
    try {
      node.reactions = reactions;
      var legacySaved = clonePrototypeValue(node.reactions || []);
      if (JSON.stringify(legacySaved) === JSON.stringify(reactions)) return;
    } catch (legacyError) {
      throw new Error(
        "setReactionsAsync failed after 2 attempts: " +
        prototypeErrorMessage(asyncError) +
        "; legacy setter failed: " + prototypeErrorMessage(legacyError)
      );
    }
    throw asyncError;
  }
  if ("reactions" in node) {
    node.reactions = reactions;
    return;
  }
  throw new Error("Node type " + node.type + " does not support prototype reactions.");
}

handlers.getReactions = async function(params) {
  var node = await resolveNode(params);
  if (!node) throw new Error("Node not found for getReactions.");
  var reactions = readPrototypeReactions(node);
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    count: reactions.length,
    reactions: reactions,
  };
};

handlers.setReactions = async function(params) {
  var node = await resolveNode(params);
  if (!node) throw new Error("Node not found for setReactions.");
  if (!Array.isArray(params.reactions) || !params.reactions.length) {
    throw new Error("setReactions requires a non-empty reactions array.");
  }

  var warnings = [];
  var normalized = [];
  for (var index = 0; index < params.reactions.length; index++) {
    normalized.push(await normalizePrototypeReaction(params.reactions[index], warnings));
  }

  var mode = String(params.mode || "replace").toLowerCase();
  var nextReactions;
  if (mode === "append") {
    nextReactions = readPrototypeReactions(node).concat(normalized);
  } else if (mode === "replace") {
    nextReactions = normalized;
  } else {
    throw new Error("setReactions mode must be replace or append.");
  }

  await writePrototypeReactions(node, nextReactions);
  var saved = readPrototypeReactions(node);
  return {
    id: node.id,
    name: node.name,
    mode: mode,
    count: saved.length,
    reactions: saved,
    warnings: warnings,
  };
};

handlers.removeReactions = async function(params) {
  var node = await resolveNode(params);
  if (!node) throw new Error("Node not found for removeReactions.");
  var existing = readPrototypeReactions(node);
  var next = [];
  var removed = 0;

  if (
    params.index === undefined &&
    !Array.isArray(params.indices) &&
    !params.triggerType
  ) {
    removed = existing.length;
  } else {
    var indices = Array.isArray(params.indices)
      ? params.indices.map(function(value) { return Number(value); })
      : (params.index !== undefined ? [Number(params.index)] : []);
    var triggerType = null;
    if (params.triggerType) {
      triggerType = String(params.triggerType).toUpperCase();
      triggerType = PROTOTYPE_TRIGGER_ALIASES[triggerType] || triggerType;
      if (!PROTOTYPE_TRIGGER_TYPES[triggerType]) {
        throw new Error("Unsupported prototype trigger filter: " + params.triggerType);
      }
    }
    for (var index = 0; index < existing.length; index++) {
      var reaction = existing[index];
      var shouldRemove =
        indices.indexOf(index) !== -1 ||
        (triggerType && reaction.trigger && reaction.trigger.type === triggerType);
      if (shouldRemove) removed++;
      else next.push(reaction);
    }
  }

  await writePrototypeReactions(node, next);
  return {
    id: node.id,
    name: node.name,
    removed: removed,
    count: next.length,
    reactions: next,
  };
};

handlers.setScrollBehavior = async function(params) {
  var node = await resolveNode(params);
  if (!node) throw new Error("Node not found for setScrollBehavior.");
  if (!("overflowDirection" in node)) {
    throw new Error(
      "Node type " + node.type +
      " does not support overflowDirection; use a FRAME, COMPONENT, or INSTANCE."
    );
  }

  var direction = String(params.overflowDirection || params.direction || "NONE").toUpperCase();
  if (["NONE", "HORIZONTAL", "VERTICAL", "BOTH"].indexOf(direction) === -1) {
    throw new Error("overflowDirection must be NONE, HORIZONTAL, VERTICAL, or BOTH.");
  }
  node.overflowDirection = direction;
  if (params.clipsContent !== undefined && "clipsContent" in node) {
    node.clipsContent = Boolean(params.clipsContent);
  }
  if (params.numberOfFixedChildren !== undefined && "numberOfFixedChildren" in node) {
    var fixedCount = Number(params.numberOfFixedChildren);
    if (!Number.isInteger(fixedCount) || fixedCount < 0) {
      throw new Error("numberOfFixedChildren must be a non-negative integer.");
    }
    if (node.children && fixedCount > node.children.length) {
      throw new Error(
        "numberOfFixedChildren cannot exceed the frame child count (" +
        node.children.length + ")."
      );
    }
    node.numberOfFixedChildren = fixedCount;
  }

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    overflowDirection: node.overflowDirection,
    clipsContent: "clipsContent" in node ? node.clipsContent : null,
    numberOfFixedChildren:
      "numberOfFixedChildren" in node ? node.numberOfFixedChildren : null,
  };
};
