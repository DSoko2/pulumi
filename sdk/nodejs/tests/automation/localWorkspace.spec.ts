// Copyright 2016-2021, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "assert";
import * as semver from "semver";
import * as upath from "upath";

import {
    ConfigMap,
    EngineEvent,
    fullyQualifiedStackName,
    LocalWorkspace,
    OutputMap,
    ProjectSettings,
    Stack,
    parseAndValidatePulumiVersion,
} from "../../automation";
import { Config, output } from "../../index";
import { getTestOrg, getTestSuffix } from "./util";

const versionRegex = /(\d+\.)(\d+\.)(\d+)(-.*)?/;
const userAgent = "pulumi/pulumi/test";

describe("LocalWorkspace", () => {
    it(`projectSettings from yaml/yml/json`, async () => {
        for (const ext of ["yaml", "yml", "json"]) {
            const ws = await LocalWorkspace.create({ workDir: upath.joinSafe(__dirname, "data", ext) });
            const settings = await ws.projectSettings();
            assert(settings.name, "testproj");
            assert(settings.runtime, "go");
            assert(settings.description, "A minimal Go Pulumi program");
        }
    });

    it(`stackSettings from yaml/yml/json`, async () => {
        for (const ext of ["yaml", "yml", "json"]) {
            const ws = await LocalWorkspace.create({ workDir: upath.joinSafe(__dirname, "data", ext) });
            const settings = await ws.stackSettings("dev");
            assert.strictEqual(settings.secretsProvider, "abc");
            assert.strictEqual(settings.config!["plain"], "plain");
            assert.strictEqual(settings.config!["secure"].secure, "secret");
        }
    });

    it(`adds/removes/lists plugins successfully`, async () => {
        const ws = await LocalWorkspace.create({});
        await ws.installPlugin("aws", "v3.0.0");
        // See https://github.com/pulumi/pulumi/issues/11013 for why this is disabled
        //await ws.installPluginFromServer("scaleway", "v1.2.0", "github://api.github.com/lbrlabs");
        await ws.removePlugin("aws", "3.0.0");
        await ws.listPlugins();
    });

    it(`create/select/remove LocalWorkspace stack`, async () => {
        const projectName = "node_test";
        const projectSettings: ProjectSettings = {
            name: projectName,
            runtime: "nodejs",
        };
        const ws = await LocalWorkspace.create({ projectSettings });
        const stackName = fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`);
        await ws.createStack(stackName);
        await ws.selectStack(stackName);
        await ws.removeStack(stackName);
    });

    it(`create/select/createOrSelect Stack`, async () => {
        const projectName = "node_test";
        const projectSettings: ProjectSettings = {
            name: projectName,
            runtime: "nodejs",
        };
        const ws = await LocalWorkspace.create({ projectSettings });
        const stackName = fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`);
        await Stack.create(stackName, ws);
        await Stack.select(stackName, ws);
        await Stack.createOrSelect(stackName, ws);
        await ws.removeStack(stackName);
    });
    describe("Tag methods: get/set/remove/list", () => {
        const projectName = "testProjectName";
        const runtime = "nodejs";
        const stackName = fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`);
        const projectSettings: ProjectSettings = {
            name: projectName,
            runtime,
        };
        let workspace: LocalWorkspace;
        beforeEach(async () => {
            workspace = await LocalWorkspace.create({
                projectSettings: projectSettings,
            });
            await workspace.createStack(stackName);
        });
        it("lists tag values", async () => {
            const result = await workspace.listTags(stackName);
            assert.strictEqual(result["pulumi:project"], projectName);
            assert.strictEqual(result["pulumi:runtime"], runtime);
        });
        it("sets and removes tag values", async () => {
            // sets
            await workspace.setTag(stackName, "foo", "bar");
            const actualValue = await workspace.getTag(stackName, "foo");
            assert.strictEqual(actualValue, "bar");
            // removes
            await workspace.removeTag(stackName, "foo");
            const actualTags = await workspace.listTags(stackName);
            assert.strictEqual(actualTags["foo"], undefined);
        });
        it("gets a single tag value", async () => {
            const actualValue = await workspace.getTag(stackName, "pulumi:project");
            assert.strictEqual(actualValue, actualValue.trim());
            assert.strictEqual(actualValue, projectName);
        });
        afterEach(async () => {
            await workspace.removeStack(stackName);
        });
    });
    it(`Config`, async () => {
        const projectName = "node_test";
        const projectSettings: ProjectSettings = {
            name: projectName,
            runtime: "nodejs",
        };
        const ws = await LocalWorkspace.create({ projectSettings });
        const stackName = fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`);
        const stack = await Stack.create(stackName, ws);

        const config = {
            plain: { value: "abc" },
            secret: { value: "def", secret: true },
        };
        let caught = 0;

        const plainKey = normalizeConfigKey("plain", projectName);
        const secretKey = normalizeConfigKey("secret", projectName);

        try {
            await stack.getConfig(plainKey);
        } catch (error) {
            caught++;
        }
        assert.strictEqual(caught, 1, "expected config get on empty value to throw");

        let values = await stack.getAllConfig();
        assert.strictEqual(Object.keys(values).length, 0, "expected stack config to be empty");
        await stack.setAllConfig(config);
        values = await stack.getAllConfig();
        assert.strictEqual(values[plainKey].value, "abc");
        assert.strictEqual(values[plainKey].secret, false);
        assert.strictEqual(values[secretKey].value, "def");
        assert.strictEqual(values[secretKey].secret, true);

        await stack.removeConfig("plain");
        values = await stack.getAllConfig();
        assert.strictEqual(Object.keys(values).length, 1, "expected stack config to have 1 value");
        await stack.setConfig("foo", { value: "bar" });
        values = await stack.getAllConfig();
        assert.strictEqual(Object.keys(values).length, 2, "expected stack config to have 2 values");

        await ws.removeStack(stackName);
    });
    it(`config_flag_like`, async () => {
        const projectName = "config_flag_like";
        const projectSettings: ProjectSettings = {
            name: projectName,
            runtime: "nodejs",
        };
        const ws = await LocalWorkspace.create({ projectSettings });
        const stackName = fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`);
        const stack = await Stack.create(stackName, ws);
        await stack.setConfig("key", {value: "-value"});
        await stack.setConfig("secret-key", {value: "-value", secret: true});
        const values = await stack.getAllConfig();
        assert.strictEqual(values["config_flag_like:key"].value, "-value");
        assert.strictEqual(values["config_flag_like:key"].secret, false);
        assert.strictEqual(values["config_flag_like:secret-key"].value, "-value");
        assert.strictEqual(values["config_flag_like:secret-key"].secret, true);
        await stack.setAllConfig({
            "key": {value: "-value2"},
            "secret-key": {value: "-value2", secret: true},
        });
        const values2 = await stack.getAllConfig();
        assert.strictEqual(values2["config_flag_like:key"].value, "-value2");
        assert.strictEqual(values2["config_flag_like:key"].secret, false);
        assert.strictEqual(values2["config_flag_like:secret-key"].value, "-value2");
        assert.strictEqual(values2["config_flag_like:secret-key"].secret, true);
    });
    it(`nested_config`, async () => {
        if (getTestOrg() !== "pulumi-test") {
            return;
        }
        const stackName = fullyQualifiedStackName(getTestOrg(), "nested_config", "dev");
        const workDir = upath.joinSafe(__dirname, "data", "nested_config");
        const stack = await LocalWorkspace.createOrSelectStack({ stackName, workDir });

        const allConfig = await stack.getAllConfig();
        const outerVal = allConfig["nested_config:outer"];
        assert.strictEqual(outerVal.secret, true);
        assert.strictEqual(outerVal.value, "{\"inner\":\"my_secret\",\"other\":\"something_else\"}");

        const listVal = allConfig["nested_config:myList"];
        assert.strictEqual(listVal.secret, false);
        assert.strictEqual(listVal.value, "[\"one\",\"two\",\"three\"]");

        const outer = await stack.getConfig("outer");
        assert.strictEqual(outer.secret, true);
        assert.strictEqual(outer.value, "{\"inner\":\"my_secret\",\"other\":\"something_else\"}");

        const list = await stack.getConfig("myList");
        assert.strictEqual(list.secret, false);
        assert.strictEqual(list.value, "[\"one\",\"two\",\"three\"]");
    });
    it(`can list stacks and currently selected stack`, async () => {
        const projectName = `node_list_test${getTestSuffix()}`;
        const projectSettings: ProjectSettings = {
            name: projectName,
            runtime: "nodejs",
        };
        const ws = await LocalWorkspace.create({ projectSettings });
        const stackNamer = () => `int_test${getTestSuffix()}`;
        const stackNames: string[] = [];
        for (let i = 0; i < 2; i++) {
            const stackName = fullyQualifiedStackName(getTestOrg(), projectName, stackNamer());
            stackNames[i] = stackName;
            await Stack.create(stackName, ws);
            const stackSummary = await ws.stack();
            assert.strictEqual(stackSummary?.current, true);
            const stacks = await ws.listStacks();
            assert.strictEqual(stacks.length, i + 1);
        }

        for (const name of stackNames) {
            await ws.removeStack(name);
        }
    });
    it(`returns valid whoami result`, async () => {
        const projectName = "node_test";
        const projectSettings: ProjectSettings = {
            name: projectName,
            runtime: "nodejs",
        };
        const ws = await LocalWorkspace.create({ projectSettings });
        const whoAmIResult = await ws.whoAmI();
        assert(whoAmIResult.user !== null);
        assert(whoAmIResult.url !== null);
    });
    it(`stack status methods`, async () => {
        const projectName = "node_test";
        const projectSettings: ProjectSettings = {
            name: projectName,
            runtime: "nodejs",
        };
        const ws = await LocalWorkspace.create({ projectSettings });
        const stackName = fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`);
        const stack = await Stack.create(stackName, ws);
        const history = await stack.history();
        assert.strictEqual(history.length, 0);
        const info = await stack.info();
        assert.strictEqual(typeof (info), "undefined");
        await ws.removeStack(stackName);
    });
    // TODO[pulumi/pulumi#8220] understand why this test was flaky
    xit(`runs through the stack lifecycle with a local program`, async () => {
        const stackName = fullyQualifiedStackName(getTestOrg(), "testproj", `int_test${getTestSuffix()}`);
        const workDir = upath.joinSafe(__dirname, "data", "testproj");
        const stack = await LocalWorkspace.createStack({ stackName, workDir });

        const config: ConfigMap = {
            "bar": { value: "abc" },
            "buzz": { value: "secret", secret: true },
        };
        await stack.setAllConfig(config);

        // pulumi up
        const upRes = await stack.up({ userAgent });
        assert.strictEqual(Object.keys(upRes.outputs).length, 3);
        assert.strictEqual(upRes.outputs["exp_static"].value, "foo");
        assert.strictEqual(upRes.outputs["exp_static"].secret, false);
        assert.strictEqual(upRes.outputs["exp_cfg"].value, "abc");
        assert.strictEqual(upRes.outputs["exp_cfg"].secret, false);
        assert.strictEqual(upRes.outputs["exp_secret"].value, "secret");
        assert.strictEqual(upRes.outputs["exp_secret"].secret, true);
        assert.strictEqual(upRes.summary.kind, "update");
        assert.strictEqual(upRes.summary.result, "succeeded");

        // pulumi preview
        const preRes = await stack.preview({ userAgent });
        assert.strictEqual(preRes.changeSummary.same, 1);

        // pulumi refresh
        const refRes = await stack.refresh({ userAgent });
        assert.strictEqual(refRes.summary.kind, "refresh");
        assert.strictEqual(refRes.summary.result, "succeeded");

        // pulumi destroy
        const destroyRes = await stack.destroy({ userAgent });
        assert.strictEqual(destroyRes.summary.kind, "destroy");
        assert.strictEqual(destroyRes.summary.result, "succeeded");

        await stack.workspace.removeStack(stackName);
    });
    it(`runs through the stack lifecycle with a local dotnet program`, async () => {
        const stackName = fullyQualifiedStackName(getTestOrg(), "testproj_dotnet", `int_test${getTestSuffix()}`);
        const workDir = upath.joinSafe(__dirname, "data", "testproj_dotnet");
        const stack = await LocalWorkspace.createStack({ stackName, workDir });

        // pulumi up
        const upRes = await stack.up({ userAgent });
        assert.strictEqual(Object.keys(upRes.outputs).length, 1);
        assert.strictEqual(upRes.outputs["exp_static"].value, "foo");
        assert.strictEqual(upRes.outputs["exp_static"].secret, false);
        assert.strictEqual(upRes.summary.kind, "update");
        assert.strictEqual(upRes.summary.result, "succeeded");

        // pulumi preview
        const preRes = await stack.preview({ userAgent });
        assert.strictEqual(preRes.changeSummary.same, 1);

        // pulumi refresh
        const refRes = await stack.refresh({ userAgent });
        assert.strictEqual(refRes.summary.kind, "refresh");
        assert.strictEqual(refRes.summary.result, "succeeded");

        // pulumi destroy
        const destroyRes = await stack.destroy({ userAgent });
        assert.strictEqual(destroyRes.summary.kind, "destroy");
        assert.strictEqual(destroyRes.summary.result, "succeeded");

        await stack.workspace.removeStack(stackName);
    });
    it(`runs through the stack lifecycle with an inline program`, async () => {
        const program = async () => {
            const config = new Config();
            return {
                exp_static: "foo",
                exp_cfg: config.get("bar"),
                exp_secret: config.getSecret("buzz"),
            };
        };
        const projectName = "inline_node";
        const stackName = fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`);
        const stack = await LocalWorkspace.createStack({ stackName, projectName, program });

        const stackConfig: ConfigMap = {
            "bar": { value: "abc" },
            "buzz": { value: "secret", secret: true },
        };
        await stack.setAllConfig(stackConfig);

        // pulumi up
        const upRes = await stack.up({ userAgent });
        assert.strictEqual(Object.keys(upRes.outputs).length, 3);
        assert.strictEqual(upRes.outputs["exp_static"].value, "foo");
        assert.strictEqual(upRes.outputs["exp_static"].secret, false);
        assert.strictEqual(upRes.outputs["exp_cfg"].value, "abc");
        assert.strictEqual(upRes.outputs["exp_cfg"].secret, false);
        assert.strictEqual(upRes.outputs["exp_secret"].value, "secret");
        assert.strictEqual(upRes.outputs["exp_secret"].secret, true);
        assert.strictEqual(upRes.summary.kind, "update");
        assert.strictEqual(upRes.summary.result, "succeeded");

        // pulumi preview
        const preRes = await stack.preview({ userAgent });
        assert.strictEqual(preRes.changeSummary.same, 1);

        // pulumi refresh
        const refRes = await stack.refresh({ userAgent });
        assert.strictEqual(refRes.summary.kind, "refresh");
        assert.strictEqual(refRes.summary.result, "succeeded");

        // pulumi destroy
        const destroyRes = await stack.destroy({ userAgent });
        assert.strictEqual(destroyRes.summary.kind, "destroy");
        assert.strictEqual(destroyRes.summary.result, "succeeded");

        await stack.workspace.removeStack(stackName);
    });
    it(`successfully initializes multiple stacks`, async () => {
        const program = async () => {
            const config = new Config();
            return {
                exp_static: "foo",
                exp_cfg: config.get("bar"),
                exp_secret: config.getSecret("buzz"),
            };
        };
        const projectName = "inline_node";
        const stackNames = Array.from(Array(10).keys()).map(_ => fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`));
        const stacks = await Promise.all(stackNames.map(async stackName => LocalWorkspace.createStack({ stackName, projectName, program })));
        await stacks.map(stack => stack.workspace.removeStack(stack.name));
    });
    it(`runs through the stack lifecycle with multiple inline programs in parallel`, async () => {
        const program = async () => {
            const config = new Config();
            return {
                exp_static: "foo",
                exp_cfg: config.get("bar"),
                exp_secret: config.getSecret("buzz"),
            };
        };
        const projectName = "inline_node";
        const stackNames = Array.from(Array(10).keys()).map(_ => fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`));

        const testStackLifetime = async (stackName: string) => {
            const stack = await LocalWorkspace.createStack({ stackName, projectName, program });

            const stackConfig: ConfigMap = {
                "bar": { value: "abc" },
                "buzz": { value: "secret", secret: true },
            };
            await stack.setAllConfig(stackConfig);

            // pulumi up
            const upRes = await stack.up({ userAgent }); // pulumi up
            assert.strictEqual(Object.keys(upRes.outputs).length, 3);
            assert.strictEqual(upRes.outputs["exp_static"].value, "foo");
            assert.strictEqual(upRes.outputs["exp_static"].secret, false);
            assert.strictEqual(upRes.outputs["exp_cfg"].value, "abc");
            assert.strictEqual(upRes.outputs["exp_cfg"].secret, false);
            assert.strictEqual(upRes.outputs["exp_secret"].value, "secret");
            assert.strictEqual(upRes.outputs["exp_secret"].secret, true);
            assert.strictEqual(upRes.summary.kind, "update");
            assert.strictEqual(upRes.summary.result, "succeeded");

            // pulumi preview
            const preRes = await stack.preview({ userAgent }); // pulumi preview
            assert.strictEqual(preRes.changeSummary.same, 1);

            // pulumi refresh
            const refRes = await stack.refresh({ userAgent });
            assert.strictEqual(refRes.summary.kind, "refresh");
            assert.strictEqual(refRes.summary.result, "succeeded");

            // pulumi destroy
            const destroyRes = await stack.destroy({ userAgent });
            assert.strictEqual(destroyRes.summary.kind, "destroy");
            assert.strictEqual(destroyRes.summary.result, "succeeded");

            await stack.workspace.removeStack(stack.name);
        };

        await Promise.all(stackNames.map(async stackName => await testStackLifetime(stackName)));
    });
    it(`handles events`, async () => {
        const program = async () => {
            const config = new Config();
            return {
                exp_static: "foo",
                exp_cfg: config.get("bar"),
                exp_secret: config.getSecret("buzz"),
            };
        };
        const projectName = "inline_node";
        const stackName = fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`);
        const stack = await LocalWorkspace.createStack({ stackName, projectName, program });

        const stackConfig: ConfigMap = {
            "bar": { value: "abc" },
            "buzz": { value: "secret", secret: true },
        };
        await stack.setAllConfig(stackConfig);

        let seenSummaryEvent = false;
        const findSummaryEvent = (event: EngineEvent) => {
            if (event.summaryEvent) {
                seenSummaryEvent = true;
            }
        };

        // pulumi preview
        const preRes = await stack.preview({ onEvent: findSummaryEvent });
        assert.strictEqual(seenSummaryEvent, true, "No SummaryEvent for `preview`");
        assert.strictEqual(preRes.changeSummary.create, 1);

        // pulumi up
        seenSummaryEvent = false;
        const upRes = await stack.up({ onEvent: findSummaryEvent });
        assert.strictEqual(seenSummaryEvent, true, "No SummaryEvent for `up`");
        assert.strictEqual(upRes.summary.kind, "update");
        assert.strictEqual(upRes.summary.result, "succeeded");

        // pulumi preview
        seenSummaryEvent = false;
        const preResAgain = await stack.preview({ onEvent: findSummaryEvent });
        assert.strictEqual(seenSummaryEvent, true, "No SummaryEvent for `preview`");
        assert.strictEqual(preResAgain.changeSummary.same, 1);

        // pulumi refresh
        seenSummaryEvent = false;
        const refRes = await stack.refresh({ onEvent: findSummaryEvent });
        assert.strictEqual(seenSummaryEvent, true, "No SummaryEvent for `refresh`");
        assert.strictEqual(refRes.summary.kind, "refresh");
        assert.strictEqual(refRes.summary.result, "succeeded");

        // pulumi destroy
        seenSummaryEvent = false;
        const destroyRes = await stack.destroy({ onEvent: findSummaryEvent });
        assert.strictEqual(seenSummaryEvent, true, "No SummaryEvent for `destroy`");
        assert.strictEqual(destroyRes.summary.kind, "destroy");
        assert.strictEqual(destroyRes.summary.result, "succeeded");

        await stack.workspace.removeStack(stackName);
    });
    // TODO[pulumi/pulumi#7127]: Re-enabled the warning.
    // Temporarily skipping test until we've re-enabled the warning.
    it.skip(`has secret config warnings`, async () => {
        const program = async () => {
            const config = new Config();

            config.get("plainstr1");
            config.require("plainstr2");
            config.getSecret("plainstr3");
            config.requireSecret("plainstr4");

            config.getBoolean("plainbool1");
            config.requireBoolean("plainbool2");
            config.getSecretBoolean("plainbool3");
            config.requireSecretBoolean("plainbool4");

            config.getNumber("plainnum1");
            config.requireNumber("plainnum2");
            config.getSecretNumber("plainnum3");
            config.requireSecretNumber("plainnum4");

            config.getObject("plainobj1");
            config.requireObject("plainobj2");
            config.getSecretObject("plainobj3");
            config.requireSecretObject("plainobj4");

            config.get("str1");
            config.require("str2");
            config.getSecret("str3");
            config.requireSecret("str4");

            config.getBoolean("bool1");
            config.requireBoolean("bool2");
            config.getSecretBoolean("bool3");
            config.requireSecretBoolean("bool4");

            config.getNumber("num1");
            config.requireNumber("num2");
            config.getSecretNumber("num3");
            config.requireSecretNumber("num4");

            config.getObject("obj1");
            config.requireObject("obj2");
            config.getSecretObject("obj3");
            config.requireSecretObject("obj4");
        };
        const projectName = "inline_node";
        const stackName = fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`);
        const stack = await LocalWorkspace.createStack({ stackName, projectName, program });

        const stackConfig: ConfigMap = {
            "plainstr1": { value: "1" },
            "plainstr2": { value: "2" },
            "plainstr3": { value: "3" },
            "plainstr4": { value: "4" },
            "plainbool1": { value: "true" },
            "plainbool2": { value: "true" },
            "plainbool3": { value: "true" },
            "plainbool4": { value: "true" },
            "plainnum1": { value: "1" },
            "plainnum2": { value: "2" },
            "plainnum3": { value: "3" },
            "plainnum4": { value: "4" },
            "plainobj1": { value: "{}" },
            "plainobj2": { value: "{}" },
            "plainobj3": { value: "{}" },
            "plainobj4": { value: "{}" },
            "str1": { value: "1", secret: true },
            "str2": { value: "2", secret: true },
            "str3": { value: "3", secret: true },
            "str4": { value: "4", secret: true },
            "bool1": { value: "true", secret: true },
            "bool2": { value: "true", secret: true },
            "bool3": { value: "true", secret: true },
            "bool4": { value: "true", secret: true },
            "num1": { value: "1", secret: true },
            "num2": { value: "2", secret: true },
            "num3": { value: "3", secret: true },
            "num4": { value: "4", secret: true },
            "obj1": { value: "{}", secret: true },
            "obj2": { value: "{}", secret: true },
            "obj3": { value: "{}", secret: true },
            "obj4": { value: "{}", secret: true },
        };
        await stack.setAllConfig(stackConfig);

        let events: string[] = [];
        const findDiagnosticEvents = (event: EngineEvent) => {
            if (event.diagnosticEvent?.severity === "warning") {
                events.push(event.diagnosticEvent.message);
            }
        };

        const expectedWarnings = [
            "Configuration 'inline_node:str1' value is a secret; use `getSecret` instead of `get`",
            "Configuration 'inline_node:str2' value is a secret; use `requireSecret` instead of `require`",
            "Configuration 'inline_node:bool1' value is a secret; use `getSecretBoolean` instead of `getBoolean`",
            "Configuration 'inline_node:bool2' value is a secret; use `requireSecretBoolean` instead of `requireBoolean`",
            "Configuration 'inline_node:num1' value is a secret; use `getSecretNumber` instead of `getNumber`",
            "Configuration 'inline_node:num2' value is a secret; use `requireSecretNumber` instead of `requireNumber`",
            "Configuration 'inline_node:obj1' value is a secret; use `getSecretObject` instead of `getObject`",
            "Configuration 'inline_node:obj2' value is a secret; use `requireSecretObject` instead of `requireObject`",
        ];

        // These keys should not be in any warning messages.
        const unexpectedWarnings = [
            "plainstr1",
            "plainstr2",
            "plainstr3",
            "plainstr4",
            "plainbool1",
            "plainbool2",
            "plainbool3",
            "plainbool4",
            "plainnum1",
            "plainnum2",
            "plainnum3",
            "plainnum4",
            "plainobj1",
            "plainobj2",
            "plainobj3",
            "plainobj4",
            "str3",
            "str4",
            "bool3",
            "bool4",
            "num3",
            "num4",
            "obj3",
            "obj4",
        ];

        const validate = (warnings: string[]) => {
            for (const expected of expectedWarnings) {
                let found = false;
                for (const warning of warnings) {
                    if (warning.includes(expected)) {
                        found = true;
                        break;
                    }
                }
                assert.strictEqual(found, true, `expected warning not found`);
            }
            for (const unexpected of unexpectedWarnings) {
                for (const warning of warnings) {
                    assert.strictEqual(warning.includes(unexpected), false,
                        `Unexpected '${unexpected}' found in warning`);
                }
            }
        };

        // pulumi preview
        await stack.preview({ onEvent: findDiagnosticEvents });
        validate(events);

        // pulumi up
        events = [];
        await stack.up({ onEvent: findDiagnosticEvents });
        validate(events);

        await stack.workspace.removeStack(stackName);
    });
    it(`imports and exports stacks`, async () => {
        const program = async () => {
            const config = new Config();
            return {
                exp_static: "foo",
                exp_cfg: config.get("bar"),
                exp_secret: config.getSecret("buzz"),
            };
        };
        const projectName = "import_export_node";
        const stackName = fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`);
        const stack = await LocalWorkspace.createStack({ stackName, projectName, program });

        try {
            await stack.setAllConfig({
                "bar": { value: "abc" },
                "buzz": { value: "secret", secret: true },
            });
            await stack.up();

            // export stack
            const state = await stack.exportStack();

            // import stack
            await stack.importStack(state);
            const configVal = await stack.getConfig("bar");
            assert.strictEqual(configVal.value, "abc");
        } finally {
            const destroyRes = await stack.destroy();
            assert.strictEqual(destroyRes.summary.kind, "destroy");
            assert.strictEqual(destroyRes.summary.result, "succeeded");
            await stack.workspace.removeStack(stackName);
        }
    });
    // TODO[pulumi/pulumi#8061] flaky test
    xit(`supports stack outputs`, async () => {
        const program = async () => {
            const config = new Config();
            return {
                exp_static: "foo",
                exp_cfg: config.get("bar"),
                exp_secret: config.getSecret("buzz"),
            };
        };
        const projectName = "import_export_node";
        const stackName = fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`);
        const stack = await LocalWorkspace.createStack({ stackName, projectName, program });

        const assertOutputs = (outputs: OutputMap) => {
            assert.strictEqual(Object.keys(outputs).length, 3, "expected to have 3 outputs");
            assert.strictEqual(outputs["exp_static"].value, "foo");
            assert.strictEqual(outputs["exp_static"].secret, false);
            assert.strictEqual(outputs["exp_cfg"].value, "abc");
            assert.strictEqual(outputs["exp_cfg"].secret, false);
            assert.strictEqual(outputs["exp_secret"].value, "secret");
            assert.strictEqual(outputs["exp_secret"].secret, true);
        };

        try {
            await stack.setAllConfig({
                "bar": { value: "abc" },
                "buzz": { value: "secret", secret: true },
            });

            const initialOutputs = await stack.outputs();
            assert.strictEqual(Object.keys(initialOutputs).length, 0, "expected initialOutputs to be empty");

            // pulumi up
            const upRes = await stack.up();
            assert.strictEqual(upRes.summary.kind, "update");
            assert.strictEqual(upRes.summary.result, "succeeded");
            assertOutputs(upRes.outputs);

            const outputsAfterUp = await stack.outputs();
            assertOutputs(outputsAfterUp);

            const destroyRes = await stack.destroy();
            assert.strictEqual(destroyRes.summary.kind, "destroy");
            assert.strictEqual(destroyRes.summary.result, "succeeded");

            const outputsAfterDestroy = await stack.outputs();
            assert.strictEqual(Object.keys(outputsAfterDestroy).length, 0, "expected outputsAfterDestroy to be empty");
        } finally {
            await stack.workspace.removeStack(stackName);
        }
    });
    it(`runs an inline program that rejects a promise and exits gracefully`, async () => {
        const program = async () => {
            Promise.reject(new Error());
            return {};
        };
        const projectName = "inline_node";
        const stackName = fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`);
        const stack = await LocalWorkspace.createStack({ stackName, projectName, program });

        // pulumi up
        await assert.rejects(stack.up());

        // pulumi destroy
        const destroyRes = await stack.destroy();
        assert.strictEqual(destroyRes.summary.kind, "destroy");
        assert.strictEqual(destroyRes.summary.result, "succeeded");

        await stack.workspace.removeStack(stackName);
    });
    it(`detects inline programs with side by side pulumi and throws an error`, async () => {

        const program = async () => {
            // clear pulumi/pulumi from require cache
            delete require.cache[require.resolve("../../runtime")];
            delete require.cache[require.resolve("../../runtime/config")];
            delete require.cache[require.resolve("../../runtime/settings")];
            // load up a fresh instance of pulumi
            const p1 = require("../../runtime/settings");
            // do some work that happens to observe runtime options with the new instance
            p1.monitorSupportsSecrets();
            return {
                // export an output from originally pulumi causing settings to be observed again (boom).
                test: output("original_pulumi"),
            };
        };
        const projectName = "inline_node_sxs";
        const stackName = fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`);
        const stack = await LocalWorkspace.createStack({ stackName, projectName, program });

        // pulumi up
        await assert.rejects(stack.up(), (err: Error) => {
            return err.stack!.indexOf("Detected multiple versions of '@pulumi/pulumi'") >= 0;
        });

        // pulumi destroy
        const destroyRes = await stack.destroy();
        assert.strictEqual(destroyRes.summary.kind, "destroy");
        assert.strictEqual(destroyRes.summary.result, "succeeded");

        await stack.workspace.removeStack(stackName);
    });
    it(`sets pulumi version`, async () => {
        const ws = await LocalWorkspace.create({});
        assert(ws.pulumiVersion);
        assert.strictEqual(versionRegex.test(ws.pulumiVersion), true);
    });
    it(`respects existing project settings`, async () => {
        const projectName = "correct_project";
        const stackName = fullyQualifiedStackName(getTestOrg(), projectName, `int_test${getTestSuffix()}`);
        const stack = await LocalWorkspace.createStack(
            { stackName, projectName, program: async () => { return; } },
            { workDir: upath.joinSafe(__dirname, "data", "correct_project") },
        );
        const projectSettings = await stack.workspace.projectSettings();
        assert.strictEqual(projectSettings.name, "correct_project");
        // the description check is enough to verify that the stack wasn't overwritten
        assert.strictEqual(projectSettings.description, "This is a description");
        await stack.workspace.removeStack(stackName);
    });
    it(`correctly sets config on multiple stacks concurrently`, async () => {
        const dones = [];
        const stacks = ["dev", "dev2", "dev3", "dev4", "dev5"];
        const workDir = upath.joinSafe(__dirname, "data", "tcfg");
        const ws = await LocalWorkspace.create({
            workDir,
            projectSettings: {
                name: "concurrent-config",
                runtime: "nodejs",
                backend: { url: "file://~" },
            },
            envVars: {
                "PULUMI_CONFIG_PASSPHRASE": "test",
            },
        });
        for (let i = 0; i < stacks.length; i++) {
            await Stack.create(stacks[i], ws);
        }
        for (let i = 0; i < stacks.length; i++) {
            const x = i;
            const s = stacks[i];
            dones.push((async () => {
                for (let j = 0; j < 20; j++) {
                    await ws.setConfig(s, "var-" + j, { value: ((x * 20) + j).toString() });
                }
            })());
        }
        await Promise.all(dones);

        for (let i = 0; i < stacks.length; i++) {
            const stack = await LocalWorkspace.selectStack({
                stackName: stacks[i],
                workDir,
            });
            const config = await stack.getAllConfig();
            assert.strictEqual(Object.keys(config).length, 20);
            await stack.workspace.removeStack(stacks[i]);
        }
    });
});

const MAJOR = /Major version mismatch./;
const MINIMUM = /Minimum version requirement failed./;
const PARSE = /Failed to parse/;

describe(`checkVersionIsValid`, () => {
    const versionTests = [
        {
            name: "higher_major",
            currentVersion: "100.0.0",
            expectError: MAJOR,
            optOut: false,
        },
        {
            name: "lower_major",
            currentVersion: "1.0.0",
            expectError: MINIMUM,
            optOut: false,
        },
        {
            name: "higher_minor",
            currentVersion: "v2.22.0",
            expectError: null,
            optOut: false,
        },
        {
            name: "lower_minor",
            currentVersion: "v2.1.0",
            expectError: MINIMUM,
            optOut: false,
        },
        {
            name: "equal_minor_higher_patch",
            currentVersion: "v2.21.2",
            expectError: null,
            optOut: false,
        },
        {
            name: "equal_minor_equal_patch",
            currentVersion: "v2.21.1",
            expectError: null,
            optOut: false,
        },
        {
            name: "equal_minor_lower_patch",
            currentVersion: "v2.21.0",
            expectError: MINIMUM,
            optOut: false,
        },
        {
            name: "equal_minor_equal_patch_prerelease",
            // Note that prerelease < release so this case will error
            currentVersion: "v2.21.1-alpha.1234",
            expectError: MINIMUM,
            optOut: false,
        },
        {
            name: "opt_out_of_check_would_fail_otherwise",
            currentVersion: "v2.20.0",
            expectError: null,
            optOut: true,
        },
        {
            name: "opt_out_of_check_would_succeed_otherwise",
            currentVersion: "v2.22.0",
            expectError: null,
            optOut: true,
        },
        {
            name: "invalid_version",
            currentVersion: "invalid",
            expectError: PARSE,
            optOut: false,
        },
        {
            name: "invalid_version_opt_out",
            currentVersion: "invalid",
            expectError: null,
            optOut: true,
        },
    ];
    const minVersion = new semver.SemVer("v2.21.1");

    versionTests.forEach(test => {
        it(`validates ${test.name} (${test.currentVersion})`, () => {
            const validate = () => parseAndValidatePulumiVersion(minVersion, test.currentVersion, test.optOut);
            if (test.expectError) {
                assert.throws(validate, test.expectError);
            } else {
                assert.doesNotThrow(validate);
            }
        });
    });
});

const normalizeConfigKey = (key: string, projectName: string) => {
    const parts = key.split(":");
    if (parts.length < 2) {
        return `${projectName}:${key}`;
    }
    return "";
};
