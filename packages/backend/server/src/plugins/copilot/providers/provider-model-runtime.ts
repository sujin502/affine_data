import { z } from 'zod';

import { CopilotPromptInvalid } from '../../../base';
import {
  type LlmBackendConfig,
  llmInferPromptModelConditions,
  llmMatchModelCapabilities,
  llmMatchModelRegistry,
  type LlmProtocol,
  llmResolveModelRegistryVariant,
} from '../../../native';
import { applyPromptAttachmentMimeTypeHintForNative } from './attachments';
import {
  type CopilotChatOptions,
  type CopilotImageOptions,
  type CopilotModelBackendKind,
  type CopilotProviderExecution,
  type CopilotProviderModel,
  CopilotProviderType,
  type CopilotStructuredOptions,
  EmbeddingMessage,
  type ModelAttachmentCapability,
  type ModelCapability,
  type ModelFullConditions,
  ModelInputType,
  ModelOutputType,
  type PromptAttachmentKind,
  type PromptAttachmentSourceKind,
  type PromptMessage,
  PromptMessageSchema,
} from './types';

// Owner: backend host model-selection glue.
// Capability matching and catalog lookup are delegated to native/adapter; this
// file keeps provider prefix/default/prefer behavior and Node prompt checks.
export type ProviderModelRuntimeContext = {
  type: CopilotProviderType;
  backendKind: CopilotModelBackendKind;
};

export type ResolvedProviderModel = CopilotProviderModel & {
  backendKind: CopilotModelBackendKind;
  canonicalKey: string;
  protocol?: LlmProtocol;
  requestLayer?: LlmBackendConfig['request_layer'];
  routeOverrides?: Partial<
    Record<
      ModelOutputType,
      {
        protocol?: LlmProtocol;
        requestLayer?: LlmBackendConfig['request_layer'];
      }
    >
  >;
  behaviorFlags?: string[];
};

function unique<T>(values: Iterable<T>) {
  return Array.from(new Set(values));
}

function resolveAttachmentCapability(
  cap: ModelCapability,
  outputType?: ModelOutputType
): ModelAttachmentCapability | undefined {
  if (outputType === ModelOutputType.Structured) {
    return cap.structuredAttachments ?? cap.attachments;
  }
  return cap.attachments;
}

function toProviderModel(
  variant: NonNullable<
    ReturnType<typeof llmResolveModelRegistryVariant>['variant']
  >
): ResolvedProviderModel {
  return {
    id: variant.rawModelId,
    name: variant.displayName,
    backendKind: variant.backendKind,
    canonicalKey: variant.canonicalKey,
    protocol: variant.protocol,
    requestLayer: variant.requestLayer,
    routeOverrides: variant.routeOverrides,
    behaviorFlags: variant.behaviorFlags,
    capabilities: variant.capabilities.map(capability => ({
      input: capability.input as ModelInputType[],
      output: capability.output as ModelOutputType[],
      attachments: capability.attachments
        ? {
            kinds: capability.attachments.kinds as PromptAttachmentKind[],
            sourceKinds: capability.attachments.sourceKinds as
              | ModelAttachmentCapability['sourceKinds']
              | undefined,
            allowRemoteUrls: capability.attachments.allowRemoteUrls,
          }
        : undefined,
      structuredAttachments: capability.structuredAttachments
        ? {
            kinds: capability.structuredAttachments
              .kinds as PromptAttachmentKind[],
            sourceKinds: capability.structuredAttachments.sourceKinds as
              | ModelAttachmentCapability['sourceKinds']
              | undefined,
            allowRemoteUrls: capability.structuredAttachments.allowRemoteUrls,
          }
        : undefined,
      defaultForOutputType: capability.defaultForOutputType,
    })),
  };
}

export type ProviderModelSelection = {
  kind: 'configured';
  model: ResolvedProviderModel;
};

type CustomModelRuntimeContext = ProviderModelRuntimeContext & {
  execution?: CopilotProviderExecution;
};

function formatConfiguredModelName(modelId: string) {
  return modelId
    .split(/[-_.\s/]+/)
    .filter(Boolean)
    .map(part =>
      part.length <= 3 && part === part.toLowerCase()
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join(' ');
}

function createOpenAICompatibleModel(
  context: ProviderModelRuntimeContext,
  modelId: string,
  outputType: ModelOutputType
): ResolvedProviderModel | undefined {
  if (context.type !== CopilotProviderType.OpenAI) {
    return;
  }
  if (
    outputType !== ModelOutputType.Text &&
    outputType !== ModelOutputType.Structured &&
    outputType !== ModelOutputType.Object &&
    outputType !== ModelOutputType.Embedding
  ) {
    return;
  }

  const output =
    outputType === ModelOutputType.Object ? ModelOutputType.Text : outputType;
  const protocol: LlmProtocol =
    outputType === ModelOutputType.Embedding
      ? 'openai_chat'
      : 'openai_responses';

  return {
    id: modelId,
    name: formatConfiguredModelName(modelId),
    backendKind: context.backendKind,
    canonicalKey: `${context.backendKind}:${modelId}`,
    protocol,
    requestLayer: context.backendKind,
    capabilities: [
      {
        input: [ModelInputType.Text],
        output: [output],
      },
    ],
  };
}

function resolveConfiguredProfileModel(
  context: CustomModelRuntimeContext,
  cond: ModelFullConditions
): ProviderModelSelection | undefined {
  const modelId = cond.modelId;
  const outputType = cond.outputType;
  const profileModels = context.execution?.profile.models;
  if (!modelId || !outputType || !profileModels?.includes(modelId)) {
    return;
  }

  const model = createOpenAICompatibleModel(context, modelId, outputType);
  if (!model) {
    return;
  }

  return {
    kind: 'configured',
    model,
  };
}

export function resolveProviderModelSelection(
  context: ProviderModelRuntimeContext,
  cond: ModelFullConditions,
  execution?: CopilotProviderExecution
): ProviderModelSelection | undefined {
  const runtimeContext = { ...context, execution };
  if (cond.modelId) {
    const resolved = llmResolveModelRegistryVariant({
      backendKind: context.backendKind,
      modelId: cond.modelId,
    }).variant;
    if (!resolved) {
      return resolveConfiguredProfileModel(runtimeContext, cond);
    }

    const model = toProviderModel(resolved);
    const matchedModelId = llmMatchModelCapabilities([model], {
      ...cond,
      modelId: model.id,
    });
    if (!matchedModelId) {
      return resolveConfiguredProfileModel(runtimeContext, cond);
    }

    return {
      kind: 'configured',
      model,
    };
  }

  const resolved = llmMatchModelRegistry({
    backendKind: context.backendKind,
    cond,
  }).variant;
  if (!resolved) {
    return;
  }

  return {
    kind: 'configured',
    model: toProviderModel(resolved),
  };
}

function isMultimodal(model: CopilotProviderModel) {
  return model.capabilities.some(c =>
    [ModelInputType.Image, ModelInputType.Audio, ModelInputType.File].some(t =>
      c.input.includes(t)
    )
  );
}

function handleZodError(ret: z.SafeParseReturnType<any, any>) {
  if (ret.success) return;
  const issues = ret.error.issues.map(i => {
    const path =
      'root' +
      (i.path.length
        ? `.${i.path.map(seg => (typeof seg === 'number' ? `[${seg}]` : `.${seg}`)).join('')}`
        : '');
    return `${i.message}${path}`;
  });
  throw new CopilotPromptInvalid(issues.join('; '));
}

export async function inferModelConditionsFromMessages(
  messages?: PromptMessage[],
  withAttachment = true
): Promise<Partial<ModelFullConditions>> {
  if (!messages?.length || !withAttachment) return {};
  const projectedMessages = messages.map(message => ({
    role: message.role,
    content: message.content,
    ...(Array.isArray(message.attachments) && message.attachments.length
      ? {
          attachments: message.attachments.map(attachment =>
            applyPromptAttachmentMimeTypeHintForNative(attachment, message)
          ),
        }
      : {}),
  }));
  const inferredCond = llmInferPromptModelConditions(projectedMessages);

  return {
    ...(inferredCond.attachmentKinds?.length
      ? { attachmentKinds: unique(inferredCond.attachmentKinds) }
      : {}),
    ...(inferredCond.attachmentSourceKinds?.length
      ? {
          attachmentSourceKinds: unique(
            inferredCond.attachmentSourceKinds
          ) as PromptAttachmentSourceKind[],
        }
      : {}),
    ...(inferredCond.inputTypes?.length
      ? { inputTypes: unique(inferredCond.inputTypes) as ModelInputType[] }
      : {}),
    ...(inferredCond.hasRemoteAttachments
      ? { hasRemoteAttachments: true }
      : {}),
  };
}

export function mergeModelConditions(
  cond: ModelFullConditions,
  inferredCond: Partial<ModelFullConditions>
): ModelFullConditions {
  return {
    ...inferredCond,
    ...cond,
    inputTypes: unique([
      ...(inferredCond.inputTypes ?? []),
      ...(cond.inputTypes ?? []),
    ]),
    attachmentKinds: unique([
      ...(inferredCond.attachmentKinds ?? []),
      ...(cond.attachmentKinds ?? []),
    ]),
    attachmentSourceKinds: unique([
      ...(inferredCond.attachmentSourceKinds ?? []),
      ...(cond.attachmentSourceKinds ?? []),
    ]),
    hasRemoteAttachments:
      cond.hasRemoteAttachments ?? inferredCond.hasRemoteAttachments,
  };
}

export function getAttachCapability(
  model: CopilotProviderModel,
  outputType: ModelOutputType
): ModelAttachmentCapability | undefined {
  const capability =
    model.capabilities.find(cap => cap.output.includes(outputType)) ??
    model.capabilities[0];
  if (!capability) {
    return;
  }
  return resolveAttachmentCapability(capability, outputType);
}

export function matchProviderModel(
  context: ProviderModelRuntimeContext,
  cond: ModelFullConditions,
  execution?: CopilotProviderExecution
): boolean {
  return !!resolveProviderModelSelection(context, cond, execution);
}

export function resolveProviderModel(
  context: ProviderModelRuntimeContext,
  modelId: string,
  execution?: CopilotProviderExecution
): ResolvedProviderModel | undefined {
  return resolveProviderModelSelection(
    context,
    {
      modelId,
    },
    execution
  )?.model;
}

export function hasProviderModelBehaviorFlag(
  model: CopilotProviderModel,
  flag: string
) {
  const behaviorFlags = (model as ResolvedProviderModel).behaviorFlags;
  return Array.isArray(behaviorFlags) && behaviorFlags.includes(flag);
}

export function resolveProviderModelRoute(
  model: CopilotProviderModel,
  outputType: ModelOutputType
) {
  const resolved = model as ResolvedProviderModel;
  const override = resolved.routeOverrides?.[outputType];

  return {
    protocol: override?.protocol ?? resolved.protocol,
    requestLayer: override?.requestLayer ?? resolved.requestLayer,
  };
}

export function requireProviderModelSelection(
  context: ProviderModelRuntimeContext,
  cond: ModelFullConditions,
  execution?: CopilotProviderExecution
): ResolvedProviderModel {
  const selection = resolveProviderModelSelection(context, cond, execution);
  if (selection) return selection.model;

  const { modelId, outputType, inputTypes } = cond;
  throw new CopilotPromptInvalid(
    modelId
      ? `Model ${modelId} does not support ${outputType ?? '<any>'} output with ${inputTypes ?? '<any>'} input`
      : outputType
        ? `No model supports ${outputType} output with ${inputTypes ?? '<any>'} input for provider ${context.type}`
        : 'Output type is required when modelId is not provided'
  );
}

export async function checkProviderParams(
  context: ProviderModelRuntimeContext,
  {
    cond,
    messages,
    embeddings,
    options = {},
    withAttachment = true,
  }: {
    cond: ModelFullConditions;
    messages?: PromptMessage[];
    embeddings?: string[];
    options?:
      | CopilotChatOptions
      | CopilotStructuredOptions
      | CopilotImageOptions;
    withAttachment?: boolean;
    execution?: CopilotProviderExecution;
  }
): Promise<ModelFullConditions> {
  if (messages) {
    const { requireContent = true, requireAttachment = false } = options;

    const MessageSchema = z
      .array(
        PromptMessageSchema.extend({
          content: requireContent
            ? z.string().trim().min(1)
            : z.string().optional().nullable(),
        })
          .passthrough()
          .catchall(z.union([z.string(), z.number(), z.date(), z.null()]))
      )
      .optional();

    handleZodError(MessageSchema.safeParse(messages));

    const inferredCond = await inferModelConditionsFromMessages(
      messages,
      withAttachment
    );
    const mergedCond = mergeModelConditions(cond, inferredCond);
    const model = requireProviderModelSelection(context, mergedCond, execution);
    const multimodal = isMultimodal(model);

    if (
      multimodal &&
      requireAttachment &&
      !messages.some(
        message =>
          message.role === 'user' &&
          Array.isArray(message.attachments) &&
          message.attachments.length > 0
      )
    ) {
      throw new CopilotPromptInvalid('attachments required in multimodal mode');
    }

    if (embeddings) {
      handleZodError(EmbeddingMessage.safeParse(embeddings));
    }

    return mergedCond;
  }

  const inferredCond = await inferModelConditionsFromMessages(
    messages,
    withAttachment
  );
  const mergedCond = mergeModelConditions(cond, inferredCond);

  if (embeddings) {
    handleZodError(EmbeddingMessage.safeParse(embeddings));
  }

  return mergedCond;
}
