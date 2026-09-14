import type { Core } from '@strapi/strapi';
import { registerPermissions } from './permissions';

const register = async ({ strapi }: { strapi: Core.Strapi }) => {
  await registerPermissions(strapi);
};

export default register;
