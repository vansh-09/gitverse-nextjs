import prisma from "../prisma";
import { GitService } from "./gitService";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

export interface AnalyzeRepositoryInput {
  name: string;
  url: string;
  description?: string;
  userId: number;
}

export type RepositoryAnalysisProgress = {
  progressPercent?: number;
  progressMessage?: string;
  progressDetails?: unknown;
};

export type RepositoryAnalysisProgressReporter = (
  update: RepositoryAnalysisProgress
) => void | Promise<void>;

export class RepositoryService {
  /**
   * Create a new repository record or return existing one
   */
  async createRepository(input: AnalyzeRepositoryInput) {
    // Check if repository with same URL already exists for this user
    const existingRepository = await prisma.repository.findFirst({
      where: {
        url: input.url,
        userId: input.userId,
      },
    });

    if (existingRepository) {
      console.log(`Repository already exists: ${existingRepository.id}`);

      return existingRepository;
    }

    const repository = await prisma.repository.create({
      data: {
        name: input.name,
        url: input.url,
        description: input.description,
        userId: input.userId,
        status: "pending",
      },
    });

    return repository;
  }

  /**
   * Analyze a repository and store all data
   */
  async analyzeRepository(
    repositoryId: number,
    opts?: { onProgress?: RepositoryAnalysisProgressReporter }
  ) {
    const repository = await prisma.repository.findUnique({
      where: { id: repositoryId },
    });

    if (!repository) {
      throw new Error("Repository not found");
    }

    // Update status to analyzing
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { status: "analyzing" },
    });

    const report = async (update: RepositoryAnalysisProgress) => {
      if (!opts?.onProgress) return;
      try {
        await opts.onProgress(update);
      } catch {
        // Progress reporting must never break analysis.
      }
    };

    await report({ progressPercent: 1, progressMessage: "Starting" });

    // Create temporary directory for cloning
    const tempDir = path.join(
      os.tmpdir(),
      "gitverse",
      `repo-${repositoryId}-${crypto.randomBytes(8).toString("hex")}`
    );

    let gitService: GitService | null = null;

    try {
      // Clone repository
      console.log(`Cloning repository ${repository.url} to ${tempDir}`);
      await report({
        progressPercent: 5,
        progressMessage: "Cloning repository",
      });
      gitService = await GitService.cloneRepository(repository.url, tempDir);

      // Get repository size
      await report({
        progressPercent: 10,
        progressMessage: "Calculating size",
      });
      const size = await gitService.getRepositorySize();

      // Analyze branches
      console.log(`Analyzing branches for repository ${repositoryId}`);
      await report({
        progressPercent: 15,
        progressMessage: "Analyzing branches",
      });
      const branches = await gitService.getBranches();
      const defaultBranch = branches.find((b) => b.isDefault)?.name || "main";

      await prisma.branch.createMany({
        data: branches.map((branch) => ({
          name: branch.name,
          isDefault: branch.isDefault,
          isProtected: branch.isProtected,
          commitCount: branch.commitCount,
          lastCommitAt: branch.lastCommitAt,
          repositoryId,
        })),
        skipDuplicates: true,
      });

      // Analyze commits from all branches
      console.log(`Analyzing commits for repository ${repositoryId}`);
      await report({
        progressPercent: 25,
        progressMessage: "Reading commit history",
      });
      const commits = await gitService.getCommits("--all", 1000);
      console.log(`Total commits fetched from git: ${commits.length}`);

      // IMPORTANT: Do not load *all* existing commits for the repo.
      // On large repos this can be huge and cause OOM/timeouts. We only need to
      // know which of the commits we just fetched already exist.
      const existingCommits =
        commits.length > 0
          ? await prisma.commit.findMany({
              where: {
                repositoryId,
                hash: { in: commits.map((c) => c.hash) },
              },
              select: { hash: true },
            })
          : [];
      const existingHashes = new Set(existingCommits.map((c) => c.hash));

      // Filter out commits that already exist
      const newCommits = commits.filter(
        (commit) => !existingHashes.has(commit.hash)
      );

      console.log(
        `Found ${commits.length} commits, ${newCommits.length} are new, ${existingCommits.length} already exist`
      );

      let insertedCount = 0;
      let failedCount = 0;

      const totalNewCommits = Math.max(1, newCommits.length);
      let lastCommitProgressUpdateAt = Date.now();

      for (const commit of newCommits) {
        try {
          const createdCommit = await prisma.commit.create({
            data: {
              hash: commit.hash,
              shortHash: commit.shortHash,
              message: commit.message,
              description: commit.description,
              authorName: commit.authorName,
              authorEmail: commit.authorEmail,
              committedAt: commit.committedAt,
              branch: commit.branch,
              parents: commit.parents || [],
              refs: commit.refs || [],
              tags: commit.tags || [],
              additions: commit.additions,
              deletions: commit.deletions,
              filesChanged: commit.filesChanged,
              repositoryId,
            },
          });

          insertedCount++;

          // Periodically report progress (every ~2s)
          if (Date.now() - lastCommitProgressUpdateAt > 2000) {
            const pct = 25 + Math.round((insertedCount / totalNewCommits) * 35);
            await report({
              progressPercent: Math.min(60, pct),
              progressMessage: `Storing commits (${insertedCount}/${newCommits.length})`,
            });
            lastCommitProgressUpdateAt = Date.now();
          }

          // Store file changes
          if (commit.fileChanges.length > 0) {
            await prisma.fileChange.createMany({
              data: commit.fileChanges.map((change) => ({
                path: change.path,
                additions: change.additions,
                deletions: change.deletions,
                changeType: change.changeType,
                commitId: createdCommit.id,
              })),
              skipDuplicates: true,
            });
          }
        } catch (error: any) {
          failedCount++;
          console.error(
            `Failed to insert commit ${commit.hash}:`,
            error.message
          );
          // Continue with next commit
        }
      }

      console.log(
        `Commit insertion complete: ${insertedCount} inserted, ${failedCount} failed`
      );

      // Analyze files
      console.log(`Analyzing file tree for repository ${repositoryId}`);
      await report({ progressPercent: 65, progressMessage: "Scanning files" });
      const files = await gitService.getFileTree();

      // Avoid querying existing file paths (can be huge). Just rely on
      // `skipDuplicates` with the unique constraint (repositoryId, path).
      if (files.length > 0) {
        const chunkSize = 500;
        for (let i = 0; i < files.length; i += chunkSize) {
          const chunk = files.slice(i, i + chunkSize);
          await prisma.file.createMany({
            data: chunk.map((file) => ({
              path: file.path,
              name: file.name,
              extension: file.extension,
              size: file.size,
              lines: file.lines,
              language: file.language,
              repositoryId,
            })),
            skipDuplicates: true,
          });

          const insertedSoFar = Math.min(files.length, i + chunk.length);
          await report({
            progressPercent:
              65 + Math.round((insertedSoFar / files.length) * 10),
            progressMessage: `Storing files (${insertedSoFar}/${files.length})`,
          });
        }
        console.log(
          `File scan complete: processed ${files.length} paths for repository ${repositoryId}`
        );
      } else {
        console.log(`No files found for repository ${repositoryId}`);
      }

      // Analyze contributors
      console.log(`Analyzing contributors for repository ${repositoryId}`);
      await report({
        progressPercent: 80,
        progressMessage: "Analyzing contributors",
      });
      const contributors = await gitService.getContributors();
      const totalContributions = contributors.reduce(
        (sum, c) => sum + c.commits,
        0
      );

      if (contributors.length > 0) {
        await prisma.contributor.createMany({
          data: contributors.map((contributor) => {
            const percentage =
              totalContributions > 0
                ? (contributor.commits / totalContributions) * 100
                : 0;
            return {
              name: contributor.name,
              email: contributor.email,
              commits: contributor.commits,
              additions: contributor.additions,
              deletions: contributor.deletions,
              percentage,
              firstCommit: contributor.firstCommit,
              lastCommit: contributor.lastCommit,
              repositoryId,
            };
          }),
          skipDuplicates: true,
        });
      }

      // Detect languages
      console.log(`Detecting languages for repository ${repositoryId}`);
      await report({
        progressPercent: 90,
        progressMessage: "Detecting languages",
      });
      const languages = await gitService.detectLanguages();

      // Languages to ignore (config/data formats, not actual code)
      const ignoredLanguages = ["JSON", "YAML", "Markdown", "TOML", "CSV"];

      // Filter out ignored languages
      const filteredLanguages = languages.filter(
        (lang) => !ignoredLanguages.includes(lang.name)
      );

      // Recalculate percentages based on remaining languages only
      const totalBytes = filteredLanguages.reduce(
        (sum, lang) => sum + lang.bytes,
        0
      );
      const rawPercentages = filteredLanguages.map((lang) =>
        totalBytes > 0 ? (lang.bytes / totalBytes) * 100 : 0
      );

      // Round to 2 decimal places
      const roundedPercentages = rawPercentages.map(
        (p) => Math.round(p * 100) / 100
      );

      // Adjust to ensure sum is exactly 100%
      const sum = roundedPercentages.reduce((acc, val) => acc + val, 0);
      if (sum > 0 && sum !== 100) {
        const diff = 100 - sum;
        // Add difference to the largest percentage
        const maxIndex = roundedPercentages.indexOf(
          Math.max(...roundedPercentages)
        );
        roundedPercentages[maxIndex] =
          Math.round((roundedPercentages[maxIndex] + diff) * 100) / 100;
      }

      const languagesWithAdjustedPercentage = filteredLanguages.map(
        (lang, index) => ({
          ...lang,
          percentage: roundedPercentages[index],
        })
      );

      if (languagesWithAdjustedPercentage.length > 0) {
        await prisma.language.createMany({
          data: languagesWithAdjustedPercentage.map((language) => ({
            name: language.name,
            percentage: language.percentage,
            bytes: language.bytes,
            lines: language.lines,
            repositoryId,
          })),
          skipDuplicates: true,
        });
      }

      // Update repository with final data
      await prisma.repository.update({
        where: { id: repositoryId },
        data: {
          status: "completed",
          lastAnalyzedAt: new Date(),
          defaultBranch,
          size: size,
        },
      });

      await report({ progressPercent: 100, progressMessage: "Completed" });

      console.log(`Repository ${repositoryId} analysis completed`);
    } catch (error: any) {
      console.error(`Error analyzing repository ${repositoryId}:`, error);
      await prisma.repository.update({
        where: { id: repositoryId },
        data: { status: "failed" },
      });
      await report({ progressMessage: "Failed" });
      throw error;
    } finally {
      // Cleanup cloned repository
      if (gitService) {
        await gitService.cleanup();
      }
    }
  }

  /**
   * Get repository with all related data
   */
  async getRepository(id: number, userId: number) {
    const repository = await prisma.repository.findFirst({
      where: {
        id,
        userId,
      },
      include: {
        branches: {
          orderBy: { isDefault: "desc" },
        },
        commits: {
          orderBy: { committedAt: "desc" },
          take: 100,
          include: {
            fileChanges: true,
          },
        },
        contributors: {
          orderBy: { commits: "desc" },
        },
        languages: {
          orderBy: { percentage: "desc" },
        },
        files: {
          orderBy: { path: "asc" },
          take: 500,
        },
      },
    });

    return repository;
  }

  /**
   * List all repositories for a user
   */
  async listRepositories(userId: number) {
    const repositories = await prisma.repository.findMany({
      where: { userId },
      include: {
        _count: {
          select: {
            commits: true,
            contributors: true,
            files: true,
            branches: true,
          },
        },
        languages: {
          orderBy: { percentage: "desc" },
          take: 3,
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return repositories;
  }

  /**
   * Delete a repository and all its data
   */
  async deleteRepository(id: number, userId: number) {
    const repository = await prisma.repository.findFirst({
      where: { id, userId },
    });

    if (!repository) {
      throw new Error("Repository not found");
    }

    await prisma.repository.delete({
      where: { id },
    });

    return { success: true };
  }

  /**
   * Get repository statistics
   */
  async getRepositoryStats(id: number, userId: number) {
    const repository = await prisma.repository.findFirst({
      where: { id, userId },
    });

    if (!repository) {
      throw new Error("Repository not found");
    }

    const [
      totalCommits,
      totalContributors,
      totalFiles,
      totalBranches,
      recentActivity,
    ] = await Promise.all([
      prisma.commit.count({ where: { repositoryId: id } }),
      prisma.contributor.count({ where: { repositoryId: id } }),
      prisma.file.count({ where: { repositoryId: id } }),
      prisma.branch.count({ where: { repositoryId: id } }),
      prisma.commit.findMany({
        where: { repositoryId: id },
        orderBy: { committedAt: "desc" },
        take: 10,
        select: {
          shortHash: true,
          message: true,
          authorName: true,
          committedAt: true,
        },
      }),
    ]);

    return {
      totalCommits,
      totalContributors,
      totalFiles,
      totalBranches,
      recentActivity,
      status: repository.status,
      lastAnalyzedAt: repository.lastAnalyzedAt,
    };
  }
}

export const repositoryService = new RepositoryService();
