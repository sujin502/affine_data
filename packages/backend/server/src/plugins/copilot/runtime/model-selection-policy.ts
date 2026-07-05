import { Injectable } from '@nestjs/common';

import { Config, CopilotSessionInvalidInput } from '../../../base';
import { llmResolveRequestedModelMatch } from '../../../native';
import { CopilotProviderRegistryService } from '../providers/registry-service';

export type ResolveModelInput = {
  defaultModel: string;
  optionalModels?: string[] | null;
  requestedModelId?: string;
};

@Injectable()
export class ModelSelectionPolicy {
  constructor(
    private readonly registries: CopilotProviderRegistryService,
    private readonly config: Config
  ) {}

  private getRegistry() {
    return this.registries.getRegistry();
  }

  private getConfiguredModelIds() {
    const embeddingProviderId = this.config.copilot.providers.defaults.embedding;
    const embeddingModel = this.config.copilot.embedding.model;
    const models = this.config.copilot.providers.profiles
      .filter(
        profile =>
          profile.id !== embeddingProviderId &&
          !profile.models?.includes(embeddingModel)
      )
      .flatMap(profile => profile.models ?? []);

    return Array.from(new Set(models));
  }

  private matchRequestedModel(
    optionalModels: string[],
    requestedModelId?: string,
    defaultModel?: string,
    includeConfiguredModels = true
  ) {
    return llmResolveRequestedModelMatch({
      providerIds: [...this.getRegistry().profiles.keys()],
      optionalModels: includeConfiguredModels
        ? Array.from(
            new Set([...optionalModels, ...this.getConfiguredModelIds()])
          )
        : optionalModels,
      requestedModelId,
      defaultModel,
    });
  }

  resolveRequestedModel(input: ResolveModelInput): {
    selectedModel: string;
    matchedOptionalModel: boolean;
  } {
    if (!input.defaultModel) {
      throw new CopilotSessionInvalidInput('Model is required');
    }
    const matched = this.matchRequestedModel(
      input.optionalModels ?? [],
      input.requestedModelId,
      input.defaultModel
    );
    return {
      selectedModel: matched.selectedModel ?? input.defaultModel,
      matchedOptionalModel: matched.matchedOptionalModel,
    };
  }

  matchesModelList(models: string[], modelId?: string) {
    return this.matchRequestedModel(
      models,
      modelId,
      undefined,
      false
    ).matchedOptionalModel;
  }
}
