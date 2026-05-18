import type { Model, ModelConstructor } from "./Model.js";

export interface ObserverContract<T extends Model<any> = Model<any>> {
  creating?(model: T): Promise<void> | void;
  created?(model: T): Promise<void> | void;
  updating?(model: T): Promise<void> | void;
  updated?(model: T): Promise<void> | void;
  saving?(model: T): Promise<void> | void;
  saved?(model: T): Promise<void> | void;
  deleting?(model: T): Promise<void> | void;
  deleted?(model: T): Promise<void> | void;
  restoring?(model: T): Promise<void> | void;
  restored?(model: T): Promise<void> | void;
}

export class Observer<T extends Model<any> = Model<any>> implements ObserverContract<T> {
  creating(model: T) {}
  created(model: T) {}
  updating(model: T) {}
  updated(model: T) {}
  saving(model: T) {}
  saved(model: T) {}
  deleting(model: T) {}
  deleted(model: T) {}
  restoring(model: T) {}
  restored(model: T) {}

  static observe<TModel extends Model<any>, TObserver extends ObserverContract<TModel>>(
    this: new () => TObserver,
    modelClass: ModelConstructor<TModel>,
  ): void {
    ObserverRegistry.register(modelClass, new this());
  }
}

export class ObserverRegistry {
  private static observers = new Map<ModelConstructor<any>, ObserverContract[]>();

  static register<T extends Model<any>>(modelClass: ModelConstructor<T>, observer: ObserverContract<T>): void {
    if (!this.observers.has(modelClass)) {
      this.observers.set(modelClass, []);
    }
    this.observers.get(modelClass)!.push(observer);
  }

  static get<T extends Model<any>>(modelClass: ModelConstructor<T>): ObserverContract<T>[] {
    return this.observers.get(modelClass) || [];
  }

  static unregister<T extends Model<any>>(modelClass: ModelConstructor<T>): void {
    this.observers.delete(modelClass);
  }

  static async dispatch<T extends Model<any>>(event: keyof ObserverContract, model: T): Promise<void> {
    const observers = this.get(Object.getPrototypeOf(model).constructor as ModelConstructor<T>);
    for (const observer of observers) {
      const handler = observer[event];
      if (handler) {
        await handler(model);
      }
    }
  }
}
