import type { LbHostPlatform } from "@rakazo/contracts";
import { DiscourseDriver } from "./discourse.js";
import type { BoardDriver } from "./driver.js";
import { FlarumDriver } from "./flarum.js";
import { GenericFormDriver } from "./generic.js";
import { IpsDriver } from "./ips.js";
import { MybbDriver } from "./mybb.js";
import { NodebbDriver } from "./nodebb.js";
import { PhpbbDriver } from "./phpbb.js";
import { VanillaDriver } from "./vanilla.js";
import { VbulletinDriver } from "./vbulletin.js";
import { WoltlabDriver } from "./woltlab.js";
import { XenforoDriver } from "./xenforo.js";

export * from "./captcha.js";
export * from "./cookie-wall.js";
export * from "./discourse.js";
export * from "./driver.js";
export * from "./flarum.js";
export * from "./generic.js";
export * from "./ips.js";
export * from "./messages.js";
export * from "./mybb.js";
export * from "./nodebb.js";
export * from "./phpbb.js";
export * from "./registration-flow.js";
export * from "./vanilla.js";
export * from "./vbulletin.js";
export * from "./verify.js";
export * from "./widgets.js";
export * from "./woltlab.js";
export * from "./xenforo.js";

const DRIVERS: Partial<Record<LbHostPlatform, BoardDriver>> = {
  phpbb: new PhpbbDriver(),
  woltlab: new WoltlabDriver(),
  xenforo: new XenforoDriver(),
  ips: new IpsDriver(),
  vbulletin: new VbulletinDriver(),
  mybb: new MybbDriver(),
  discourse: new DiscourseDriver(),
  flarum: new FlarumDriver(),
  nodebb: new NodebbDriver(),
  vanilla: new VanillaDriver(),
};

/**
 * The driver for a platform. `unknown` gets a fresh generic form mapper so two hosts do not
 * share mapped fields. `qa_other` stays unmapped until a driver exists for it.
 */
export function boardDriverFor(platform: LbHostPlatform): BoardDriver | null {
  if (platform === "unknown") return new GenericFormDriver();
  return DRIVERS[platform] ?? null;
}

export function supportedPlatforms(): LbHostPlatform[] {
  return [...(Object.keys(DRIVERS) as LbHostPlatform[]), "unknown"];
}
