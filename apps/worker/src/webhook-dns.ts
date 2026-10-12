import { lookup } from "node:dns/promises";
import type { HostnameResolver } from "@rakazo/linkbuilder-core";

/** Production resolver. Tests inject their own and do not call this. */
export const dnsHostnameResolver: HostnameResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address }));
};
