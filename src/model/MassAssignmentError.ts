export class MassAssignmentError extends Error {
  constructor(
    public readonly model: string,
    public readonly attributes: string[],
  ) {
    super(
      `Add [${attributes.join(", ")}] to fillable or remove them from guarded on [${model}].`
    );
    this.name = "MassAssignmentError";
  }
}
