/* World Atelier's non-networked Linux Godot worker boundary.
 * Build: cc -O2 -Wall -Wextra -Werror tools/linux-sandbox.c -lseccomp -o wa-sandbox
 * Requires Landlock ABI >= 3. No root, namespace privileges, or Docker socket.
 * This is a filesystem/syscall boundary, not a VM or a tenant resource quota.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <sched.h>
#include <seccomp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <termios.h>
#include <unistd.h>

#if !defined(__x86_64__) && !defined(__aarch64__)
#error "Only native Linux amd64 and arm64 are supported"
#endif
#if defined(__x86_64__)
#define ELF_LOADER "/lib64/ld-linux-x86-64.so.2"
#else
#define ELF_LOADER "/lib/ld-linux-aarch64.so.1"
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#define POLICY "wa-linux-landlock-seccomp-1"
#ifndef POLICY_SOURCE_SHA256
#define POLICY_SOURCE_SHA256 "unrecorded"
#endif
#define FS_READ (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR)
#define FS_FILE (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_TRUNCATE)
#define FS_WRITE (LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER)
#define FS_HANDLED ((1ULL << 15) - 1)

static void fatal(const char *message) {
  fprintf(stderr,"World Atelier Linux isolation: %s (%s)\n",message,strerror(errno));
  exit(125);
}
static void close_inherited_fds(void) {
#ifdef SYS_close_range
  if(syscall(SYS_close_range,3U,~0U,0)==0)return;
#endif
  /* A lowered soft RLIMIT_NOFILE does not close existing high descriptors.
   * Do not emulate close_range by looping only up to that limit. */
  fatal("cannot close inherited descriptors; close_range is required");
}
static void allow_path(int ruleset,const char *path,uint64_t rights) {
  if(path[0]!='/'){errno=EINVAL;fatal("policy paths must be absolute");}
  int fd=open(path,O_PATH|O_CLOEXEC);
  if(fd<0)fatal("cannot open an explicit policy path");
  struct stat status;
  if(fstat(fd,&status))fatal("cannot inspect policy path");
  struct landlock_path_beneath_attr rule={.parent_fd=fd,.allowed_access=S_ISDIR(status.st_mode)?rights:rights&FS_FILE};
  if(syscall(SYS_landlock_add_rule,ruleset,LANDLOCK_RULE_PATH_BENEATH,&rule,0))fatal("cannot install filesystem rule");
  close(fd);
}
static int syscall_number(const char *name) {
  return seccomp_syscall_resolve_name_arch(seccomp_arch_native(),name);
}
static void allow_syscall(scmp_filter_ctx filter,const char *name) {
  int nr=syscall_number(name);
  if(nr>=0&&seccomp_rule_add(filter,SCMP_ACT_ALLOW,nr,0)<0){errno=EINVAL;fatal("cannot install syscall rule");}
}
static void install_syscalls(void) {
  /* An allowlist also denies future chmod/xattr/socket/namespace/ptrace/io_uring
   * variants that the build-time libseccomp does not know about. */
  static const char *allowed[]={
    "read","write","readv","writev","pread64","pwrite64","preadv","pwritev","preadv2","pwritev2",
    "open","openat","openat2","creat","close","close_range","lseek","flock",
    "stat","lstat","fstat","newfstatat","statx","statfs","fstatfs","access","faccessat","faccessat2",
    "readlink","readlinkat","getdents","getdents64","getcwd","chdir","fchdir",
    "mkdir","mkdirat","rmdir","unlink","unlinkat","rename","renameat","renameat2",
    "link","linkat","symlink","symlinkat","truncate","ftruncate","fallocate","fsync","fdatasync","sync_file_range",
    "copy_file_range","sendfile","splice","tee","vmsplice","pipe","pipe2","dup","dup2","dup3",
    "mmap","mprotect","munmap","mremap","msync","mincore","madvise","brk","memfd_create",
    "rt_sigaction","rt_sigprocmask","rt_sigreturn","rt_sigpending","rt_sigtimedwait","rt_sigsuspend","sigaltstack",
    "futex","futex_waitv","set_tid_address","set_robust_list","get_robust_list","rseq","membarrier",
    "epoll_create","epoll_create1","epoll_ctl","epoll_wait","epoll_pwait","epoll_pwait2",
    "poll","ppoll","select","pselect6","eventfd","eventfd2","signalfd","signalfd4",
    "timerfd_create","timerfd_settime","timerfd_gettime","timer_create","timer_settime","timer_gettime","timer_delete","timer_getoverrun",
    "clock_gettime","clock_getres","clock_nanosleep","gettimeofday","nanosleep","time","times","getrusage",
    "getpid","getppid","gettid","getuid","geteuid","getgid","getegid","getresuid","getresgid","getgroups",
    "getrlimit","setrlimit","getpriority","sched_yield","sched_getparam","sched_getscheduler","sched_get_priority_min","sched_get_priority_max","sched_getaffinity",
    "uname","sysinfo","getrandom","umask","arch_prctl","restart_syscall","exit","exit_group","execve","execveat"
  };
  scmp_filter_ctx filter=seccomp_init(SCMP_ACT_ERRNO(EPERM));
  if(!filter)fatal("cannot allocate seccomp policy");
  if(seccomp_attr_set(filter,SCMP_FLTATR_ACT_BADARCH,SCMP_ACT_KILL_PROCESS)<0)fatal("cannot reject foreign syscall ABIs");
  for(size_t i=0;i<sizeof(allowed)/sizeof(allowed[0]);i++)allow_syscall(filter,allowed[i]);
  int nr=syscall_number("clone");
  if(nr>=0&&seccomp_rule_add(filter,SCMP_ACT_ALLOW,nr,1,SCMP_A0(SCMP_CMP_MASKED_EQ,CLONE_THREAD,CLONE_THREAD))<0)fatal("cannot allow engine threads");
  nr=syscall_number("clone3");
  if(nr>=0&&seccomp_rule_add(filter,SCMP_ACT_ERRNO(ENOSYS),nr,0)<0)fatal("cannot install clone3 fallback");
  const char *self_signals[]={"kill","tgkill","rt_sigqueueinfo","rt_tgsigqueueinfo"};
  for(size_t i=0;i<sizeof(self_signals)/sizeof(self_signals[0]);i++){
    nr=syscall_number(self_signals[i]);
    if(nr>=0&&seccomp_rule_add(filter,SCMP_ACT_ALLOW,nr,1,SCMP_A0(SCMP_CMP_EQ,getpid()))<0)fatal("cannot allow same-process signals");
  }
  nr=syscall_number("prlimit64");
  if(nr>=0){
    if(seccomp_rule_add(filter,SCMP_ACT_ALLOW,nr,1,SCMP_A0(SCMP_CMP_EQ,0))<0||seccomp_rule_add(filter,SCMP_ACT_ALLOW,nr,1,SCMP_A0(SCMP_CMP_EQ,getpid()))<0)fatal("cannot allow private process limits");
  }
  /* Headless Godot may query a terminal/pipe, but may not alter a terminal,
   * device, other process, or filesystem via arbitrary ioctl requests. */
  const unsigned long ioctls[]={TCGETS,TIOCGWINSZ,FIONREAD,FIONBIO,FIOCLEX,FIONCLEX};
  nr=syscall_number("ioctl");
  if(nr>=0)for(size_t i=0;i<sizeof(ioctls)/sizeof(ioctls[0]);i++)if(seccomp_rule_add(filter,SCMP_ACT_ALLOW,nr,1,SCMP_A1(SCMP_CMP_EQ,ioctls[i]))<0)fatal("cannot allow read-only descriptor queries");
  const unsigned long controls[]={PR_SET_NAME,PR_GET_NAME,PR_GET_DUMPABLE};
  nr=syscall_number("prctl");
  if(nr>=0)for(size_t i=0;i<sizeof(controls)/sizeof(controls[0]);i++)if(seccomp_rule_add(filter,SCMP_ACT_ALLOW,nr,1,SCMP_A0(SCMP_CMP_EQ,controls[i]))<0)fatal("cannot allow thread names");
  /* F_SETOWN/F_SETSIG/F_NOTIFY and asynchronous I/O can signal another process
   * without using kill(2). Allow only descriptor flags/duplication/file locks. */
  const int fd_commands[]={F_GETFD,F_SETFD,F_GETFL,F_DUPFD,F_DUPFD_CLOEXEC,F_GETLK,F_SETLK,F_SETLKW,
#ifdef F_OFD_GETLK
    F_OFD_GETLK,F_OFD_SETLK,F_OFD_SETLKW,
#endif
#ifdef F_GETPIPE_SZ
    F_GETPIPE_SZ,F_SETPIPE_SZ,
#endif
#ifdef F_GET_SEALS
    F_GET_SEALS,F_ADD_SEALS,
#endif
  };
  const char *fd_calls[]={"fcntl","fcntl64"};
  for(size_t call=0;call<2;call++){
    nr=syscall_number(fd_calls[call]);if(nr<0)continue;
    for(size_t i=0;i<sizeof(fd_commands)/sizeof(fd_commands[0]);i++)if(seccomp_rule_add(filter,SCMP_ACT_ALLOW,nr,1,SCMP_A1(SCMP_CMP_EQ,fd_commands[i]))<0)fatal("cannot allow private descriptor operations");
    if(seccomp_rule_add(filter,SCMP_ACT_ALLOW,nr,2,SCMP_A1(SCMP_CMP_EQ,F_SETFL),SCMP_A2(SCMP_CMP_MASKED_EQ,O_ASYNC,0))<0)fatal("cannot restrict asynchronous descriptor signals");
  }
  /* The stock headless editor constructs TCP descriptors for its LSP/DAP
   * plugins. Let construction succeed so bind fails through their normal
   * unavailable-service path. No connect/bind/listen/send/recv syscall is
   * allowed; these unconnected stream descriptors cannot communicate. */
  nr=syscall_number("socket");
  const int families[]={AF_INET,AF_INET6};
  const int protocols[]={0,IPPROTO_TCP};
  if(nr>=0)for(size_t f=0;f<2;f++)for(size_t p=0;p<2;p++)if(seccomp_rule_add(filter,SCMP_ACT_ALLOW,nr,3,SCMP_A0(SCMP_CMP_EQ,families[f]),SCMP_A1(SCMP_CMP_MASKED_EQ,~(scmp_datum_t)(SOCK_CLOEXEC|SOCK_NONBLOCK),SOCK_STREAM),SCMP_A2(SCMP_CMP_EQ,protocols[p]))<0)fatal("cannot allow inert editor descriptors");
  nr=syscall_number("setsockopt");
  if(nr>=0){
    if(seccomp_rule_add(filter,SCMP_ACT_ALLOW,nr,2,SCMP_A1(SCMP_CMP_EQ,SOL_SOCKET),SCMP_A2(SCMP_CMP_EQ,SO_REUSEADDR))<0||seccomp_rule_add(filter,SCMP_ACT_ALLOW,nr,2,SCMP_A1(SCMP_CMP_EQ,IPPROTO_IPV6),SCMP_A2(SCMP_CMP_EQ,IPV6_V6ONLY))<0)fatal("cannot allow inert descriptor options");
  }
  if(seccomp_load(filter)<0)fatal("cannot enforce seccomp");
  seccomp_release(filter);
}
int main(int argc,char **argv) {
  close_inherited_fds();
  int abi=(int)syscall(SYS_landlock_create_ruleset,NULL,0,LANDLOCK_CREATE_RULESET_VERSION);
  if(abi<3){errno=ENOTSUP;fatal("Landlock ABI >= 3 is required; update the Linux/WSL/Docker kernel");}
  struct landlock_ruleset_attr policy={.handled_access_fs=FS_HANDLED};
  int ruleset=(int)syscall(SYS_landlock_create_ruleset,&policy,sizeof(policy),0);
  if(ruleset<0)fatal("Landlock is unavailable inside this container");
  int probe=argc==2&&!strcmp(argv[1],"--probe"),target=-1;
  // Linux checks execution of both the ELF and its dynamic interpreter.
  // Grant exactly the platform loader, not execution of the system bin tree.
  allow_path(ruleset,ELF_LOADER,LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_EXECUTE);
  if(probe){
    allow_path(ruleset,"/usr/lib",FS_READ);
    allow_path(ruleset,"/lib",FS_READ);
    allow_path(ruleset,"/etc/ld.so.cache",FS_READ);
    allow_path(ruleset,"/usr/bin/true",LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_EXECUTE);
  }
  if(!probe){
    for(int i=1;i<argc;i++){
      if(!strcmp(argv[i],"--")){target=i+1;break;}
      int writable=!strcmp(argv[i],"--write");
      if((!writable&&strcmp(argv[i],"--read"))||i+1>=argc){errno=EINVAL;fatal("expected --read/--write path or -- executable args");}
      allow_path(ruleset,argv[++i],FS_READ|(writable?FS_WRITE:0));
    }
    if(target<0||target>=argc||argv[target][0]!='/'){errno=EINVAL;fatal("missing absolute executable");}
    allow_path(ruleset,argv[target],LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_EXECUTE);
  }
  if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0))fatal("cannot set no_new_privs");
  if(syscall(SYS_landlock_restrict_self,ruleset,0))fatal("cannot enforce Landlock");
  close(ruleset);
  install_syscalls();
  if(probe){
    printf("{\"policy\":\"%s\",\"source_sha256\":\"%s\",\"abi\":%d,\"filesystem\":true,\"seccomp\":true,\"network\":\"denied\",\"socket_construction\":\"unconnected_tcp_only\",\"subprocesses\":\"denied\"}\n",POLICY,POLICY_SOURCE_SHA256,abi);
    fflush(stdout);char *const command[]={"/usr/bin/true",NULL};execv(command[0],command);fatal("isolated execution probe failed");
  }
  execv(argv[target],&argv[target]);
  fatal("cannot execute the isolated command");
  return 125;
}
