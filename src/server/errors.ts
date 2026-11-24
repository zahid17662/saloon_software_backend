/**
 * A failure the user should see, with a Bangla message (for example "১০ মিনিট পার হয়ে গেছে").
 * Server Actions turn it into `{ ok: false, error: message }`. Anything that is not a DomainError
 * is a bug or an outage and is shown as a generic message instead.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}
