-- New projects warm up with three link-free posts. Existing rows keep their stored warmup.
ALTER TABLE "lb_projects" ALTER COLUMN "warmup" SET DEFAULT '{"minPostsBeforeLink":3,"minAccountAgeHours":24}';
