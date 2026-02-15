/**
 * OpenAI embeddings client.
 */

import OpenAI from "openai";

export class Embeddings {
  private client: OpenAI;

  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text.slice(0, 8000), // safety truncate
    });
    return response.data[0].embedding;
  }
}
