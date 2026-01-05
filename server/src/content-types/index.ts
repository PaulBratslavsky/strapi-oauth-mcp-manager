import mcpOauthClient from './mcp-oauth-client/schema.json';
import mcpOauthCode from './mcp-oauth-code/schema.json';
import mcpOauthToken from './mcp-oauth-token/schema.json';
import mcpEndpoint from './mcp-endpoint/schema.json';

export default {
  'mcp-oauth-client': { schema: mcpOauthClient },
  'mcp-oauth-code': { schema: mcpOauthCode },
  'mcp-oauth-token': { schema: mcpOauthToken },
  'mcp-endpoint': { schema: mcpEndpoint },
};
