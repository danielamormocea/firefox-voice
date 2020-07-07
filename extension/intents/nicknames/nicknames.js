/* globals log */

import * as intentRunner from "../../background/intentRunner.js";
import * as pageMetadata from "../../background/pageMetadata.js";
import * as browserUtil from "../../browserUtil.js";
import { RoutineExecutor } from "./routineExecutor.js";
import English from "../../language/langs/english.js";

intentRunner.registerIntent({
  name: "nicknames.name",
  async run(context) {
    const intents = intentRunner.getIntentHistory();
    if (!(intents[intents.length - 1] && intents[intents.length - 2])) {
      const exc = new Error("No last intent");
      exc.displayMessage = "No previous intent available to name";
      throw exc;
    }
    if (intents[intents.length - 1].name !== "nicknames.name") {
      throw new Error("Expected previous intent to be nicknames.name");
    }
    const intent = intents[intents.length - 2];
    intentRunner.registerNickname(context.slots.name, intent);
  },
});

intentRunner.registerIntent({
  name: "nicknames.remove",
  async run(context) {
    const intents = intentRunner.getRegisteredNicknames();
    const name = context.slots.name.toLowerCase();
    if (!intents[name]) {
      const exc = new Error("No named intent to remove");
      exc.displayMessage = `No nickname "${name}" found`;
      throw exc;
    }
    intentRunner.registerNickname(name, null);
  },
});

function makeCombinedContext(contexts, nickname) {
  return new intentRunner.IntentContext({
    name: "nicknames.combined",
    nickname,
    contexts,
    slots: {},
    parameters: {},
    utterance: `Combined actions named ${nickname}`,
    fallback: false,
  });
}

intentRunner.registerIntent({
  name: "nicknames.nameLast",
  async run(context) {
    // FIXME: this should not created a nicknames.combined context if the number is 1
    const name = context.slots.name.toLowerCase();
    const number = English.nameToNumber(context.slots.number);
    const history = intentRunner.getIntentHistory().slice(-number - 1, -1);
    if (history.length < number) {
      const exc = new Error("Not enough history to save");
      exc.displayMessage = `There are not ${number} things to name (there are only ${history.length})`;
      throw exc;
    }
    const newContext = makeCombinedContext(history, name);
    intentRunner.registerNickname(name, newContext);
    log.info(
      "Created combined nickname",
      name,
      "->",
      history.map(c => c.name).join(", ")
    );
  },
});

intentRunner.registerIntent({
  name: "nicknames.combined",
  async run(context) {
    log.info(`Running a named series (${context.contexts.length}) of intents`);
    const routineExecutor = new RoutineExecutor(
      context.nickname,
      context.contexts
    );
    await routineExecutor.run();
  },
});

intentRunner.registerIntent({
  name: "nicknames.namePage",
  async run(context) {
    const name = context.slots.name;
    const activeTab = await browserUtil.activeTab();
    const metadata = await pageMetadata.getMetadata(activeTab.id);
    intentRunner.registerPageName(name, metadata);
  },
});

intentRunner.registerIntent({
  name: "nicknames.removePageName",
  async run(context) {
    const name = context.slots.name;
    await intentRunner.getRegisteredPageName(name);
    intentRunner.unregisterPageName(name);
  },
});

intentRunner.registerIntent({
  name: "nicknames.pause",
  async run(context) {
    if (context.parentRoutine === undefined) {
      const exc = new Error("Command not available");
      exc.displayMessage = "Command not available";
      throw exc;
    }
    context.parentRoutine.stop = true;
    browser.storage.sync.set({
      pausedRoutine: {
        name: context.parentRoutine.name,
        nextIndex: context.parentRoutine.nextIndex,
      },
    });
  },
});

intentRunner.registerIntent({
  name: "nicknames.continue",
  async run(context) {
    const { pausedRoutine } = await browser.storage.sync.get("pausedRoutine");
    if (pausedRoutine === undefined) {
      const exc = new Error("Command not available");
      exc.displayMessage = "Command not available";
      throw exc;
    }

    const { name, nextIndex } = pausedRoutine;
    const registeredNicknames = await intentRunner.getRegisteredNicknames();
    const routineExecutor = new RoutineExecutor(
      registeredNicknames[name].nickname,
      registeredNicknames[name].contexts,
      nextIndex
    );
    await browser.storage.sync.remove("pausedRoutine");
    await routineExecutor.run();
  },
});
