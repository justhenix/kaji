import { OwnerBudget } from "../src/budget";
export { OwnerBudget };
export { DeviceRegistry } from '../src/devices';
export default {
  fetch(request: Request, env: { OWNER_BUDGET: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }; DEVICES: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/devices/')) {
      url.pathname = url.pathname.slice('/devices'.length);
      return env.DEVICES.get(env.DEVICES.idFromName('devices-test')).fetch(new Request(url, request));
    }
    return env.OWNER_BUDGET.get(env.OWNER_BUDGET.idFromName("runtime-test")).fetch(request);
  },
};
