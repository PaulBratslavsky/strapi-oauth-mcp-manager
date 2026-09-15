import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Dialog,
  EmptyStateLayout,
  Field,
  Flex,
  IconButton,
  Modal,
  Radio,
  SingleSelect,
  SingleSelectOption,
  Switch,
  Table,
  Tbody,
  Td,
  Textarea,
  TextInput,
  Th,
  Thead,
  Tr,
  Typography,
} from '@strapi/design-system';
import { Duplicate, Plus, Trash, User, WarningCircle } from '@strapi/icons';
import { ConfirmDialog, Layouts, Page, useFetchClient, useNotification } from '@strapi/strapi/admin';

import { PLUGIN_ID } from '../pluginId';

interface Overview {
  mcpEnabled: boolean;
  encryptionKeyConfigured: boolean;
  dynamicClientRegistration: boolean;
  allowUserPermissions: boolean;
  endpoints: Record<string, string>;
}

interface Grant {
  id: number;
  clientId: string;
  clientName: string;
  adminUserId: number;
  userEmail: string | null;
  userActive: boolean;
  tokenName: string | null;
  ownsAdminToken: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  refreshExpiresAt: string;
}

interface TokenOption {
  id: number;
  name: string;
  description?: string | null;
  expiresAt?: string | null;
}

interface MappedToken {
  id: number;
  name: string | null;
  ownerId: number | null;
  ownerEmail: string | null;
  missing?: boolean;
}

const PICK_ON_CONNECT = 'pick';

interface PendingConfirmation {
  title: string;
  body: string;
  action: () => Promise<unknown>;
  successMessage: string;
}

interface Client {
  id: number;
  name: string;
  clientId: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  registrationType: 'manual' | 'dynamic';
  adminToken: MappedToken | null;
  active: boolean;
  createdAt: string;
}

interface CreatedClient {
  clientId: string;
  clientSecret: string | null;
}

const formatDate = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');

const Section = ({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode }) => (
  <Box background="neutral0" hasRadius shadow="tableShadow" padding={6}>
    <Flex justifyContent="space-between" alignItems="flex-start" gap={4} paddingBottom={4}>
      <Flex direction="column" alignItems="flex-start" gap={1}>
        <Typography variant="delta" tag="h2">
          {title}
        </Typography>
        {subtitle && <Typography textColor="neutral600">{subtitle}</Typography>}
      </Flex>
      {action}
    </Flex>
    {children}
  </Box>
);

const CopyValue = ({ label, value }: { label: string; value: string }) => {
  const { toggleNotification } = useNotification();
  return (
    <Flex gap={2} alignItems="center" paddingBottom={2}>
      <Box minWidth="220px">
        <Typography variant="omega" fontWeight="semiBold">
          {label}
        </Typography>
      </Box>
      <Typography variant="omega" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
        {value}
      </Typography>
      <IconButton
        label={`Copy ${label}`}
        variant="ghost"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          toggleNotification({ type: 'success', message: `${label} copied` });
        }}
      >
        <Duplicate />
      </IconButton>
    </Flex>
  );
};

/**
 * Choose which admin token a client uses. Admins can only map tokens they own; a token owned by
 * someone else is shown as the current value but can only be replaced or cleared.
 */
const TokenSelect = ({
  tokens,
  value,
  current,
  onChange,
  disabled,
}: {
  tokens: TokenOption[];
  value: string;
  current?: MappedToken | null;
  onChange: (value: string) => void;
  disabled?: boolean;
}) => {
  const ownsCurrent = current && tokens.some((t) => t.id === current.id);
  return (
    <SingleSelect
      aria-label="Admin token"
      value={value}
      disabled={disabled}
      onChange={(next: string | number) => onChange(String(next))}
    >
      <SingleSelectOption value={PICK_ON_CONNECT}>Picked when connecting</SingleSelectOption>
      {current && !ownsCurrent && (
        <SingleSelectOption value={String(current.id)} disabled>
          {current.missing ? 'Deleted token' : `${current.name} (owned by ${current.ownerEmail ?? 'another admin'})`}
        </SingleSelectOption>
      )}
      {tokens.map((token) => (
        <SingleSelectOption key={token.id} value={String(token.id)}>
          {token.name}
        </SingleSelectOption>
      ))}
    </SingleSelect>
  );
};

const CreateClientModal = ({ onCreated, tokens }: { onCreated: () => void; tokens: TokenOption[] }) => {
  const { post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [redirectUris, setRedirectUris] = useState('');
  const [confidential, setConfidential] = useState('confidential');
  const [adminTokenId, setAdminTokenId] = useState(PICK_ON_CONNECT);
  const [created, setCreated] = useState<CreatedClient | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setName('');
    setRedirectUris('');
    setConfidential('confidential');
    setAdminTokenId(PICK_ON_CONNECT);
    setCreated(null);
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const { data } = await post<{ data: CreatedClient }>(`/${PLUGIN_ID}/clients`, {
        name,
        redirectUris: redirectUris.split('\n').map((uri) => uri.trim()).filter(Boolean),
        confidential: confidential === 'confidential',
        adminTokenId: adminTokenId === PICK_ON_CONNECT ? null : Number(adminTokenId),
      });
      setCreated(data.data);
      onCreated();
    } catch (error: any) {
      toggleNotification({ type: 'danger', message: error?.response?.data?.error?.message ?? 'Could not create client' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Modal.Trigger>
        <Button startIcon={<Plus />}>Add client</Button>
      </Modal.Trigger>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>{created ? 'Client created' : 'Add an OAuth client'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {created ? (
            <Flex direction="column" alignItems="stretch" gap={4}>
              <Alert variant="warning" title="Copy these now" closeLabel="Close">
                The client secret is shown only once.
              </Alert>
              <CopyValue label="Client ID" value={created.clientId} />
              {created.clientSecret && <CopyValue label="Client secret" value={created.clientSecret} />}
            </Flex>
          ) : (
            <Flex direction="column" alignItems="stretch" gap={4}>
              <Typography textColor="neutral600">
                Only needed for clients that ask for a client ID and secret, like ChatGPT connectors. Claude and most MCP
                clients register themselves automatically.
              </Typography>
              <Field.Root name="name" required>
                <Field.Label>Name</Field.Label>
                <TextInput value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} placeholder="ChatGPT" />
              </Field.Root>
              <Field.Root name="redirectUris" required hint="One per line. * matches any run of characters except /.">
                <Field.Label>Redirect URIs</Field.Label>
                <Textarea
                  value={redirectUris}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setRedirectUris(e.target.value)}
                  placeholder="https://chatgpt.com/connector_platform_oauth_redirect"
                />
                <Field.Hint />
              </Field.Root>
              <Field.Root
                name="adminToken"
                hint="Map one of your admin tokens so every connection uses it. Only you can then approve this client. Leave it to let each person pick one of their own tokens."
              >
                <Field.Label>Admin token</Field.Label>
                <TokenSelect tokens={tokens} value={adminTokenId} onChange={setAdminTokenId} />
                <Field.Hint />
              </Field.Root>
              <Field.Root name="type">
                <Field.Label>Client type</Field.Label>
                <Radio.Group value={confidential} onValueChange={setConfidential} aria-label="Client type">
                  <Radio.Item value="confidential">Confidential (client ID + secret)</Radio.Item>
                  <Radio.Item value="public">Public (client ID only, PKCE required)</Radio.Item>
                </Radio.Group>
              </Field.Root>
            </Flex>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close>
            <Button variant="tertiary">{created ? 'Done' : 'Cancel'}</Button>
          </Modal.Close>
          {!created && (
            <Button onClick={submit} loading={submitting} disabled={!name.trim() || !redirectUris.trim()}>
              Create
            </Button>
          )}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
};

const HomePage = () => {
  const { get, del, put } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [tokens, setTokens] = useState<TokenOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, g, c, t] = await Promise.all([
        get<{ data: Overview }>(`/${PLUGIN_ID}/overview`),
        get<{ data: Grant[] }>(`/${PLUGIN_ID}/grants`),
        get<{ data: Client[] }>(`/${PLUGIN_ID}/clients`),
        get<{ data: TokenOption[] }>(`/${PLUGIN_ID}/tokens`),
      ]);
      setTokens(t.data.data);
      setOverview(o.data.data);
      setGrants(g.data.data);
      setClients(c.data.data);
      setLoadError(false);
    } catch {
      // Don't show empty tables for data that failed to load.
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [get, toggleNotification]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (action: () => Promise<unknown>, message: string) => {
    try {
      await action();
      toggleNotification({ type: 'success', message });
    } catch (error: any) {
      toggleNotification({ type: 'danger', message: error?.response?.data?.error?.message ?? 'Something went wrong' });
    }
    load();
  };

  if (loading) {
    return <Page.Loading />;
  }

  if (loadError) {
    return (
      <Page.Main>
        <Page.Title>MCP OAuth</Page.Title>
        <Layouts.Header title="MCP OAuth" />
        <Layouts.Content>
          <Alert
            variant="danger"
            title="Could not load MCP OAuth data"
            closeLabel="Close"
            action={
              <Button
                variant="tertiary"
                onClick={() => {
                  setLoading(true);
                  load();
                }}
              >
                Retry
              </Button>
            }
          >
            Check that you have the Manage MCP OAuth clients and grants permission and that Strapi is running.
          </Alert>
        </Layouts.Content>
      </Page.Main>
    );
  }

  return (
    <Page.Main>
      <Page.Title>MCP OAuth</Page.Title>
      <Layouts.Header
        title="MCP OAuth"
        subtitle="Let MCP clients like Claude and ChatGPT connect to Strapi's MCP server by signing in with a Strapi admin account."
      />
      <Layouts.Content>
        <Flex direction="column" alignItems="stretch" gap={6}>
          {overview && !overview.mcpEnabled && (
            <Alert variant="danger" title="Strapi's MCP server is disabled" closeLabel="Close">
              Set server.mcp.enabled to true in config/server and restart Strapi (requires Strapi 5.47 or later).
            </Alert>
          )}
          {overview && !overview.encryptionKeyConfigured && (
            <Alert variant="danger" title="Encryption key missing" closeLabel="Close">
              Set admin.secrets.encryptionKey (ENCRYPTION_KEY) so OAuth grants can store their admin token.
            </Alert>
          )}

          {overview && (
            <Section title="Connection details" subtitle="Give MCP clients the server URL. They discover everything else.">
              <CopyValue label="MCP server URL" value={overview.endpoints.resource} />
              <CopyValue label="Authorization server metadata" value={overview.endpoints.authorizationServerMetadata} />
              <CopyValue label="Authorization endpoint" value={overview.endpoints.authorization} />
              <CopyValue label="Token endpoint" value={overview.endpoints.token} />
              <Typography variant="pi" textColor="neutral600">
                Dynamic client registration is {overview.dynamicClientRegistration ? 'on' : 'off'}.
              </Typography>
            </Section>
          )}

          <Section
            title="Connected sessions"
            subtitle="Each session uses an admin token owned by the person who approved it. Deactivating that person, or deleting or regenerating the token in Settings → Admin Tokens, also ends the session."
          >
            {grants.length === 0 ? (
              <EmptyStateLayout content="No MCP clients are connected yet." />
            ) : (
              <Table colCount={6} rowCount={grants.length + 1}>
                <Thead>
                  <Tr>
                    <Th><Typography variant="sigma">Client</Typography></Th>
                    <Th><Typography variant="sigma">Approved by</Typography></Th>
                    <Th><Typography variant="sigma">Access</Typography></Th>
                    <Th><Typography variant="sigma">Last used</Typography></Th>
                    <Th><Typography variant="sigma">Expires</Typography></Th>
                    <Th><Typography variant="sigma">Actions</Typography></Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {grants.map((grant) => (
                    <Tr key={grant.id}>
                      <Td><Typography fontWeight="semiBold">{grant.clientName}</Typography></Td>
                      <Td>
                        <Flex gap={2}>
                          <Typography>{grant.userEmail ?? '—'}</Typography>
                          {!grant.userActive && <Badge variant="danger">Inactive</Badge>}
                        </Flex>
                      </Td>
                      <Td>
                        {grant.ownsAdminToken ? (
                          <Badge variant="warning">All user permissions</Badge>
                        ) : (
                          <Typography>{grant.tokenName ?? '—'}</Typography>
                        )}
                      </Td>
                      <Td><Typography>{formatDate(grant.lastUsedAt)}</Typography></Td>
                      <Td><Typography>{formatDate(grant.refreshExpiresAt)}</Typography></Td>
                      <Td>
                        <Flex gap={1}>
                          <IconButton
                            label={`Revoke this ${grant.clientName} session`}
                            variant="ghost"
                            onClick={() => run(() => del(`/${PLUGIN_ID}/grants/${grant.id}`), 'Session revoked')}
                          >
                            <Trash />
                          </IconButton>
                          <IconButton
                            label={`Revoke every session approved by ${grant.userEmail ?? 'this user'}`}
                            variant="ghost"
                            onClick={() =>
                              setConfirmation({
                                title: 'Revoke all sessions for this user?',
                                body: `Every MCP session approved by ${grant.userEmail ?? 'this user'} ends now, across all clients. Their admin tokens are kept.`,
                                action: () => del(`/${PLUGIN_ID}/users/${grant.adminUserId}/grants`),
                                successMessage: `All sessions for ${grant.userEmail ?? 'this user'} revoked`,
                              })
                            }
                          >
                            <User />
                          </IconButton>
                        </Flex>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
          </Section>

          <Section
            title="OAuth clients"
            subtitle="Deactivating or deleting a client disconnects all of its sessions."
            action={<CreateClientModal onCreated={load} tokens={tokens} />}
          >
            {clients.length === 0 ? (
              <EmptyStateLayout content="No clients yet. They appear here when an MCP client registers or you add one." />
            ) : (
              <Table colCount={6} rowCount={clients.length + 1}>
                <Thead>
                  <Tr>
                    <Th><Typography variant="sigma">Name</Typography></Th>
                    <Th><Typography variant="sigma">Type</Typography></Th>
                    <Th><Typography variant="sigma">Redirect URIs</Typography></Th>
                    <Th><Typography variant="sigma">Admin token</Typography></Th>
                    <Th><Typography variant="sigma">Active</Typography></Th>
                    <Th><Typography variant="sigma">Actions</Typography></Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {clients.map((client) => (
                    <Tr key={client.id}>
                      <Td>
                        <Flex direction="column" alignItems="flex-start">
                          <Typography fontWeight="semiBold">{client.name}</Typography>
                          <Typography variant="pi" textColor="neutral600" style={{ fontFamily: 'monospace' }}>
                            {client.clientId}
                          </Typography>
                        </Flex>
                      </Td>
                      <Td>
                        <Flex gap={1}>
                          <Badge variant={client.registrationType === 'dynamic' ? 'secondary' : 'primary'}>
                            {client.registrationType === 'dynamic' ? 'Self-registered' : 'Manual'}
                          </Badge>
                          <Badge>{client.tokenEndpointAuthMethod === 'none' ? 'Public' : 'Confidential'}</Badge>
                        </Flex>
                      </Td>
                      <Td>
                        <Typography variant="pi" style={{ wordBreak: 'break-all' }}>
                          {client.redirectUris.join(', ')}
                        </Typography>
                      </Td>
                      <Td>
                        <Box minWidth="220px">
                          <TokenSelect
                            tokens={tokens}
                            current={client.adminToken}
                            value={client.adminToken ? String(client.adminToken.id) : PICK_ON_CONNECT}
                            onChange={(next) =>
                              run(
                                () =>
                                  put(`/${PLUGIN_ID}/clients/${client.id}`, {
                                    adminTokenId: next === PICK_ON_CONNECT ? null : Number(next),
                                  }),
                                next === PICK_ON_CONNECT
                                  ? `${client.name} now lets each person pick a token`
                                  : `${client.name} now uses the selected token`
                              )
                            }
                          />
                        </Box>
                      </Td>
                      <Td>
                        <Switch
                          aria-label={`${client.name} active`}
                          checked={client.active}
                          onCheckedChange={(checked: boolean) =>
                            run(
                              () => put(`/${PLUGIN_ID}/clients/${client.id}`, { active: checked }),
                              checked ? 'Client activated' : 'Client deactivated'
                            )
                          }
                        />
                      </Td>
                      <Td>
                        <IconButton
                          label={`Delete ${client.name}`}
                          variant="ghost"
                          onClick={() =>
                            setConfirmation({
                              title: `Delete ${client.name}?`,
                              body: `${client.name} is disconnected and all of its sessions end. ${
                                client.registrationType === 'manual'
                                  ? 'Its client ID and secret stop working and cannot be recovered.'
                                  : 'The client will need to register again to reconnect.'
                              }`,
                              action: () => del(`/${PLUGIN_ID}/clients/${client.id}`),
                              successMessage: 'Client deleted',
                            })
                          }
                        >
                          <Trash />
                        </IconButton>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
          </Section>
        </Flex>
      </Layouts.Content>
      <Dialog.Root open={confirmation !== null} onOpenChange={(open: boolean) => !open && setConfirmation(null)}>
        {confirmation && (
          <ConfirmDialog
            title={confirmation.title}
            variant="danger-light"
            icon={<WarningCircle />}
            onConfirm={async () => {
              const pending = confirmation;
              setConfirmation(null);
              await run(pending.action, pending.successMessage);
            }}
          >
            {confirmation.body}
          </ConfirmDialog>
        )}
      </Dialog.Root>
    </Page.Main>
  );
};

export { HomePage };
