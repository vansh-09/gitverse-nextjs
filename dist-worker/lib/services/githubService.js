"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.githubService = exports.GitHubService = void 0;
const axios_1 = __importDefault(require("axios"));
class GitHubService {
    client;
    token;
    constructor(token) {
        this.token = token;
        this.client = axios_1.default.create({
            baseURL: 'https://api.github.com',
            headers: {
                Accept: 'application/vnd.github.v3+json',
                ...(token && { Authorization: `Bearer ${token}` }),
            },
        });
    }
    /**
     * Get authenticated user information
     */
    async getAuthenticatedUser() {
        if (!this.token) {
            throw new Error('GitHub token required for authentication');
        }
        const response = await this.client.get('/user');
        return response.data;
    }
    /**
     * Get repository information
     */
    async getRepository(owner, repo) {
        const response = await this.client.get(`/repos/${owner}/${repo}`);
        return response.data;
    }
    /**
     * List user repositories
     */
    async listUserRepositories(username, params) {
        const endpoint = username ? `/users/${username}/repos` : '/user/repos';
        const response = await this.client.get(endpoint, {
            params: {
                type: params?.type || 'owner',
                sort: params?.sort || 'updated',
                direction: params?.direction || 'desc',
                per_page: params?.per_page || 30,
                page: params?.page || 1,
            },
        });
        return response.data;
    }
    /**
     * Get repository branches
     */
    async getBranches(owner, repo) {
        const response = await this.client.get(`/repos/${owner}/${repo}/branches`);
        return response.data;
    }
    /**
     * Get repository commits
     */
    async getCommits(owner, repo, params) {
        const response = await this.client.get(`/repos/${owner}/${repo}/commits`, {
            params: {
                sha: params?.sha,
                path: params?.path,
                per_page: params?.per_page || 100,
                page: params?.page || 1,
            },
        });
        return response.data;
    }
    /**
     * Get commit details with stats
     */
    async getCommit(owner, repo, sha) {
        const response = await this.client.get(`/repos/${owner}/${repo}/commits/${sha}`);
        return response.data;
    }
    /**
     * Get repository languages
     */
    async getLanguages(owner, repo) {
        const response = await this.client.get(`/repos/${owner}/${repo}/languages`);
        return response.data;
    }
    /**
     * Get repository contributors
     */
    async getContributors(owner, repo) {
        const response = await this.client.get(`/repos/${owner}/${repo}/contributors`);
        return response.data;
    }
    /**
     * Search repositories
     */
    async searchRepositories(query, params) {
        const response = await this.client.get('/search/repositories', {
            params: {
                q: query,
                sort: params?.sort,
                order: params?.order || 'desc',
                per_page: params?.per_page || 30,
                page: params?.page || 1,
            },
        });
        return response.data;
    }
    /**
     * Parse GitHub URL to extract owner and repo
     */
    static parseGitHubUrl(url) {
        const patterns = [
            /github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?$/,
            /github\.com\/([^\/]+)\/([^\/]+)/,
        ];
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                return {
                    owner: match[1],
                    repo: match[2].replace(/\.git$/, ''),
                };
            }
        }
        return null;
    }
    /**
     * Validate GitHub token
     */
    async validateToken() {
        try {
            await this.getAuthenticatedUser();
            return true;
        }
        catch {
            return false;
        }
    }
}
exports.GitHubService = GitHubService;
exports.githubService = new GitHubService();
