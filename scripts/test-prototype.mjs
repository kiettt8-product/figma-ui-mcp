#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL("../src/plugin/handlers-prototype.js", import.meta.url),
  "utf8",
);
const builtPlugin = readFileSync(
  new URL("../plugin/code.js", import.meta.url),
  "utf8",
);
const toolDefinitions = readFileSync(
  new URL("../server/tool-definitions.js", import.meta.url),
  "utf8",
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createSceneNode(id, name, type, extra = {}) {
  return {
    id,
    name,
    type,
    reactions: [],
    async setReactionsAsync(reactions) {
      this.reactions = clone(reactions);
    },
    ...extra,
  };
}

const button = createSceneNode("1:1", "Primary Action", "FRAME");
const destination = createSceneNode("1:2", "Voucher Detail", "FRAME");
const componentVariant = createSceneNode("1:3", "State=Pressed", "COMPONENT");
const scrollFrame = createSceneNode("1:4", "Voucher List", "FRAME", {
  overflowDirection: "NONE",
  clipsContent: false,
  numberOfFixedChildren: 0,
  children: [{ id: "1:5" }, { id: "1:6" }],
});
const nodes = new Map(
  [button, destination, componentVariant, scrollFrame].map(node => [node.id, node]),
);

const context = {
  handlers: {},
  console,
  JSON,
  Number,
  Object,
  String,
  Array,
  Boolean,
  Math,
  setTimeout,
  async resolveNode(params) {
    return nodes.get(params.id || params.nodeId) || null;
  },
  async findNodeByIdAsync(id) {
    return nodes.get(id) || null;
  },
};
vm.createContext(context);
vm.runInContext(source, context, { filename: "handlers-prototype.js" });

const setResult = await context.handlers.setReactions({
  id: button.id,
  reactions: [{
    trigger: "ON_TAP",
    actions: [{
      type: "NAVIGATE",
      destinationId: destination.id,
      transition: {
        type: "SMART_ANIMATE",
        duration: 0.3,
        easing: "EASE_IN_AND_OUT",
      },
    }],
  }],
});
assert.equal(setResult.count, 1);
assert.equal(button.reactions[0].trigger.type, "ON_CLICK");
assert.deepEqual(button.reactions[0].actions[0], {
  type: "NODE",
  destinationId: destination.id,
  transition: {
    type: "SMART_ANIMATE",
    duration: 0.3,
    easing: { type: "EASE_IN_AND_OUT" },
  },
  navigation: "NAVIGATE",
  preserveScrollPosition: false,
});

await context.handlers.setReactions({
  id: button.id,
  mode: "append",
  reactions: [{
    trigger: { type: "ON_HOVER" },
    actions: [{ type: "CHANGE_TO", destinationId: componentVariant.id }],
  }],
});
assert.equal(button.reactions.length, 2);
assert.equal(button.reactions[1].actions[0].navigation, "CHANGE_TO");

const readResult = await context.handlers.getReactions({ id: button.id });
assert.equal(readResult.count, 2);
assert.equal(readResult.reactions[0].actions[0].destinationId, destination.id);

const removeResult = await context.handlers.removeReactions({
  id: button.id,
  triggerType: "ON_HOVER",
});
assert.equal(removeResult.removed, 1);
assert.equal(removeResult.count, 1);

const scrollResult = await context.handlers.setScrollBehavior({
  id: scrollFrame.id,
  overflowDirection: "VERTICAL",
  clipsContent: true,
  numberOfFixedChildren: 1,
});
assert.equal(scrollResult.overflowDirection, "VERTICAL");
assert.equal(scrollResult.clipsContent, true);
assert.equal(scrollResult.numberOfFixedChildren, 1);

const legacyButton = createSceneNode("1:7", "Legacy Runtime Button", "FRAME", {
  async setReactionsAsync() {
    throw new Error("host connection unavailable");
  },
});
nodes.set(legacyButton.id, legacyButton);
const legacyResult = await context.handlers.setReactions({
  id: legacyButton.id,
  reactions: [{
    trigger: "ON_CLICK",
    actions: [{ type: "BACK" }],
  }],
});
assert.equal(legacyResult.count, 1);
assert.equal(legacyButton.reactions[0].actions[0].type, "BACK");

await assert.rejects(
  context.handlers.setReactions({
    id: button.id,
    reactions: [{
      trigger: "ON_CLICK",
      actions: [{ type: "NAVIGATE", destinationId: "missing:1" }],
    }],
  }),
  /destination not found/i,
);

assert.match(source, /handlers\.setReactions = async function/);
assert.match(source, /handlers\.getReactions = async function/);
assert.match(source, /handlers\.removeReactions = async function/);
assert.match(source, /handlers\.setScrollBehavior = async function/);
assert.match(builtPlugin, /handlers\.setReactions = async function/);
assert.match(toolDefinitions, /"getReactions"/);

console.log("Prototype handler tests passed.");
