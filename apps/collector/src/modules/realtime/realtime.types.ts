
export type SummaryDelta = {
  upload: number;
  download: number;
  connections: number;
  lastUpdated: number;
};

export type MinuteBucket = {
  upload: number;
  download: number;
  lastUpdated: number;
};

export type ProxyDelta = {
  chain: string;
  totalUpload: number;
  totalDownload: number;
  totalConnections: number;
  lastSeen: string;
};

export type DeviceDelta = {
  sourceIP: string;
  totalUpload: number;
  totalDownload: number;
  totalConnections: number;
  lastSeen: string;
};

export type RuleDelta = {
  rule: string;
  finalProxy: string;
  totalUpload: number;
  totalDownload: number;
  totalConnections: number;
  lastSeen: string;
};

export type CountryDelta = {
  country: string;
  countryName: string;
  continent: string;
  totalUpload: number;
  totalDownload: number;
  totalConnections: number;
  lastSeen: string;
};

export type DomainDelta = {
  domain: string;
  totalUpload: number;
  totalDownload: number;
  totalConnections: number;
  lastSeen: string;
  ips: Set<string>;
  rules: Set<string>;
  chains: Set<string>;
};

export type IPDelta = {
  ip: string;
  totalUpload: number;
  totalDownload: number;
  totalConnections: number;
  lastSeen: string;
  domains: Set<string>;
  chains: Set<string>;
  rules: Set<string>;
};

export type TrafficMeta = {
  domain: string;
  ip: string;
  sourceIP?: string;
  chains: string[];
  rule: string;
  rulePayload: string;
  upload: number;
  download: number;
};
