import { Injectable, Optional } from '@nestjs/common';

import { QuotaStateService } from '../../../core/quota/state';
import { PromptService } from '../prompt/service';
import { CopilotProviderRegistryService } from '../providers/registry-service';
import { ModelOutputType } from '../providers/types';

export const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';
export const DEFAULT_RERANK_MODEL = 'gpt-4o-mini';

@Injectable()
export class TaskPolicy {
  constructor(
    private readonly quotaState: QuotaStateService,
    private readonly prompts: PromptService,
    @Optional() private readonly registries?: CopilotProviderRegistryService
  ) {}

  private resolveDefaultProfileModel(
    outputType: Exclude<ModelOutputType, typeof ModelOutputType.Rerank>
  ) {
    if (!this.registries) {
      return;
    }

    const registry = this.registries.getRegistry();
    const providerId = registry.defaults[outputType];
    const profile = providerId ? registry.profiles.get(providerId) : undefined;
    const model = profile?.models?.[0];
    return providerId && model ? `${providerId}/${model}` : undefined;
  }

  resolveEmbeddingModelId() {
    return (
      this.resolveDefaultProfileModel(ModelOutputType.Embedding) ??
      DEFAULT_EMBEDDING_MODEL
    );
  }

  resolveRerankModelId() {
    return DEFAULT_RERANK_MODEL;
  }

  async resolveTranscriptionModel(userId: string) {
    const prompt = await this.prompts.get('Transcript audio');
    if (!prompt) return;

    const state = await this.quotaState.reconcileUserQuotaState(userId);
    const flags = state.flags as { unlimitedCopilot?: boolean };
    const hasAccess =
      !!flags.unlimitedCopilot ||
      ['pro', 'lifetime_pro', 'ai'].includes(state.plan);
    return prompt.optionalModels[hasAccess ? 1 : 0] ?? prompt.model;
  }
}
