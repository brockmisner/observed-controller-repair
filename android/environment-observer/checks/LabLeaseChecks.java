package net.stakeout.environment;
public final class LabLeaseChecks {
  static int count=0;
  static void check(boolean value){count++;if(!value)throw new AssertionError("Check "+count);}
  static void rejects(Runnable f){boolean threw=false;try{f.run();}catch(IllegalArgumentException e){threw=true;}check(threw);}
  public static void main(String[] args){
    String a="11111111-1111-4111-8111-111111111111",b="22222222-2222-4222-8222-222222222222";
    LabLease x=new LabLease(0,e->{}),y=new LabLease(0,e->{});
    x.open(a,1,100);y.open(b,1,100);x.stage(a,1,0,0,"frame-a",1000,200);y.stage(b,1,0,0,"frame-b",1000,200);
    check("frame-a".equals(x.view(201).frame));check("frame-b".equals(y.view(201).frame));
    long expiry=x.view(201).expiresAt; x.stage(a,1,0,0,"frame-a",1000,300);check(x.view(301).expiresAt==expiry);
    rejects(()->x.stage(a,1,0,0,"altered",1000,400));rejects(()->x.stage(b,1,1,1,"wrong",1000,400));
    x.stage(a,1,2,2,"next",1000,400);rejects(()->x.stage(a,1,1,3,"old",1000,500));
    check(x.view(1400).frame==null);rejects(()->x.stage(a,1,3,3,"late",1000,1500));rejects(()->x.open(a,1,1600));
    x.open(a,2,1600);x.stage(a,2,0,0,"new",1000,1700);x.close(a,2,1800);check(x.view(1800).frame==null);
    rejects(()->new LabLease(2,e->{}).open(a,2,10));
    LabLease z=new LabLease(0,e->{});z.open(a,1,0);rejects(()->z.stage(a,1,1,0,"bad",10001,1));
    z.stage(a,1,1,10,"good",1000,10);rejects(()->z.stage(a,1,2,9,"clock",1000,11));
    System.out.println("LabLease: "+count+" checks passed");
  }
}
