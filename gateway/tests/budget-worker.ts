import { OwnerBudget } from "../src/budget";
export { OwnerBudget };
export default {
  fetch(request: Request, env: { OWNER_BUDGET: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }) {
    return env.OWNER_BUDGET.get(env.OWNER_BUDGET.idFromName("runtime-test")).fetch(request);
  },
};
