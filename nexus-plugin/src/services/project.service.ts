import axios from 'axios';
import { ProjectRepository, Project, CreateProjectData, UpdateProjectData } from '../database/repositories/project.repository';
import { UsageRepository } from '../database/repositories/usage.repository';
import { createLogger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';

const logger = createLogger({ component: 'project-service' });

export class ProjectService {
  constructor(
    private projectRepo: ProjectRepository,
    private usageRepo: UsageRepository
  ) {}

  async createProject(
    orgId: string,
    userId: string,
    data: {
      triggerProjectRef: string;
      triggerProjectName?: string;
      environment: 'dev' | 'staging' | 'production';
      apiKeyEncrypted?: string;
      personalAccessTokenEncrypted?: string;
      triggerApiUrl?: string;
      mode: 'self-hosted' | 'external';
    }
  ): Promise<Project> {
    if (!data.triggerProjectRef) {
      throw new ValidationError('triggerProjectRef is required');
    }

    const existing = await this.projectRepo.findByRef(orgId, data.triggerProjectRef);
    if (existing) {
      throw new ValidationError(`Project with ref ${data.triggerProjectRef} already exists`);
    }

    const project = await this.projectRepo.create({
      organizationId: orgId,
      userId,
      triggerProjectRef: data.triggerProjectRef,
      triggerProjectName: data.triggerProjectName,
      environment: data.environment,
      apiKeyEncrypted: data.apiKeyEncrypted,
      personalAccessTokenEncrypted: data.personalAccessTokenEncrypted,
      triggerApiUrl: data.triggerApiUrl || 'http://trigger-dev-webapp:3030',
      mode: data.mode,
    });

    await this.usageRepo.record(orgId, 'api_call', {
      action: 'create_project',
      projectId: project.projectId,
    });

    logger.info('Project created', {
      projectId: project.projectId,
      orgId,
      ref: data.triggerProjectRef,
    });

    return project;
  }

  async getProject(projectId: string, orgId: string): Promise<Project> {
    const project = await this.projectRepo.findById(projectId, orgId);
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }
    return project;
  }

  async listProjects(orgId: string): Promise<Project[]> {
    return this.projectRepo.findByOrgId(orgId);
  }

  async updateProject(
    projectId: string,
    orgId: string,
    data: UpdateProjectData
  ): Promise<Project> {
    const existing = await this.projectRepo.findById(projectId, orgId);
    if (!existing) {
      throw new NotFoundError('Project', projectId);
    }

    const updated = await this.projectRepo.update(projectId, orgId, data);

    logger.info('Project updated', { projectId, orgId });
    return updated;
  }

  async deleteProject(projectId: string, orgId: string): Promise<void> {
    const existing = await this.projectRepo.findById(projectId, orgId);
    if (!existing) {
      throw new NotFoundError('Project', projectId);
    }

    const deleted = await this.projectRepo.delete(projectId, orgId);
    if (!deleted) {
      throw new NotFoundError('Project', projectId);
    }

    logger.info('Project deleted', { projectId, orgId });
  }

  async testConnection(projectId: string, orgId: string): Promise<{
    success: boolean;
    latencyMs: number;
    error?: string;
  }> {
    const project = await this.projectRepo.findById(projectId, orgId);
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }

    const start = Date.now();
    try {
      const healthUrl = `${project.triggerApiUrl.replace(/\/$/, '')}/health`;
      const response = await axios.get(healthUrl, {
        timeout: 10000,
        validateStatus: (status) => status < 500,
      });

      const latencyMs = Date.now() - start;
      logger.info('Connection test succeeded', { projectId, latencyMs, status: response.status });

      return {
        success: true,
        latencyMs,
      };
    } catch (error: any) {
      const latencyMs = Date.now() - start;
      logger.warn('Connection test failed', { projectId, latencyMs, error: error.message });

      return {
        success: false,
        latencyMs,
        error: error.message,
      };
    }
  }
}
