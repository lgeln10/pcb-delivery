export class InappNotifyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'InappNotifyError'
  }
}
