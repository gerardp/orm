import type { Action, Actions } from "@sveltejs/kit";
import type { RequestEventLike } from "./route.js";

type AnyAction = (event: RequestEventLike) => unknown | Promise<unknown>;

class ActionsBuilder<TMap extends Record<string, AnyAction> = {}> {
  private readonly map: Record<string, AnyAction>;

  constructor(map: Record<string, AnyAction> = {}) {
    this.map = map;
  }

  action<TKey extends string, TAction extends AnyAction>(
    name: TKey,
    handler: TAction,
  ): ActionsBuilder<TMap & Record<TKey, TAction>> {
    return new ActionsBuilder({
      ...this.map,
      [name]: handler,
    }) as any;
  }

  build(): { [K in keyof TMap]: Action } & Actions {
    return this.map as any;
  }
}

export function actions(): ActionsBuilder<{}> {
  return new ActionsBuilder();
}

