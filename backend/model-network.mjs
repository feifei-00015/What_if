import { lookup } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';

function publicIp(address) {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.process(address);
  return parsed.range() === 'unicast';
}

export function assertPublicModelUrl(url) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || hostname.endsWith('.internal') ||
      (ipaddr.isValid(hostname) && !publicIp(hostname))) {
    throw new Error('模型接口地址不能指向本机或内部网络');
  }
}

export const modelDispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, options, (error, address, family) => {
        if (error) return callback(error);
        const addresses = Array.isArray(address) ? address.map(item => item.address) : [address];
        if (addresses.some(item => !publicIp(item))) {
          return callback(new Error('模型接口地址不能指向本机或内部网络'));
        }
        callback(null, address, family);
      });
    },
  },
});
